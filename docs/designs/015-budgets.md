# Feature Design 015: Budgets — per-category / per-currency monthly limits

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress — Phase 1 (`feat/budgets-crud`) done (merged, PR #147), Phase 2
(`feat/budget-status`) in review (PR open, not yet merged) · **Date:** 2026-07-25 · PLAN Phase 3 (insights). The
**first brand-new entity built entirely on the FC/IS write path** (ADR-021→023) — a greenfield validation that the
pattern works for an entity added from scratch, not migrated. Respects the effective-only + per-currency
invariants (Feature Design 001; `docs/architecture.md`).

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`.
> **Two sequential PRs**, each its own branch off `main`: `feat/budgets-crud` (Phase 1) →
> `feat/budget-status` (Phase 2).

## Context

Spending can be aggregated (`aggregate_spending`, `get_spending_summary`) but there's no notion of a **limit** to
measure it against. Budgets close that: a monthly cap on a category (or sub-category), in a specific currency,
and a `get_budget_status` that reports spent-vs-limit for a period.

Settled model (from design discussion):

- **Grain** — per category **or** sub-category. A **category** budget rolls up its sub-categories automatically:
  sub-category transactions carry the parent's `category_id` (`resolveSubCategory` sets
  `categoryId = parent`, `subCategoryId = sub`), and `aggregate_spending` already groups by `t.category_id`, so
  "spend on Food" = `category_id = Food` **includes** Food's sub-categories. A **sub-category** budget measures
  `subcategory_id = Restaurants`. Spend under a sub counts toward **both** its own budget and the parent's — the
  natural envelope behaviour, falling straight out of the schema.
- **Rollover** — none. Each month is measured independently; unused budget does not carry forward.
- **Currency — a required dimension, and budgets are split per currency.** A limit must be denominated in one
  currency and measured against **same-currency** spend only (no-implicit-conversion). So the identity is
  per-currency: the same category in the same month can hold a BRL budget *and* a USD budget as two rows. There
  is deliberately **no cross-currency total** — that would require FX conversion, the explicitly-deferred PLAN
  open question; until FX lands, every total here is per-currency (exactly as `get_spending_summary` already
  returns per-currency blocks). The "one coherent budget per category" view is delivered at **read time**:
  `get_budget_status` **groups the flat rows by category**, presenting per-currency lines under each
  category — the unified presentation without any nested storage.
- **Period** — a **recurring monthly limit**: one budget per (target, currency) applies to every month;
  `get_budget_status(month, year)` measures that month. No re-entry each period. `period` is stored as an enum
  (`monthly` for now) so weekly/yearly can extend later without a schema change.

## Decision

### Schema — `budgets` (migration)

| column | notes |
| --- | --- |
| `id` | TEXT PK (`crypto.randomUUID()`) |
| `category_id` | FK → `categories.id`. **The budgeted node — top-level category or sub-category** (sub-categories *are* rows in `categories`). One column, so `UNIQUE` needs no nullable discriminator. |
| `currency` | FK → `currencies.code`, NOT NULL |
| `limit_amount` | REAL, full units of `currency`, `> 0` |
| `period` | TEXT enum, `monthly` (default), extensible |
| `version` | INTEGER NOT NULL DEFAULT 0 (optimistic concurrency, ADR-021) |

**`UNIQUE(category_id, currency, period)`** — at most one budget per target/currency/period. No nullable column
in the key (the single-target-column design is chosen precisely to avoid SQLite's "NULLs are distinct" trap that
a `category_id`+nullable-`subcategory_id` pair would hit). *(Alternative considered: store `category_id` +
nullable `subcategory_id` mirroring transactions — rejected for the unique-constraint hazard; the single
`category_id` referencing either a top or sub node is cleaner and sufficient, since measurement can tell top from
sub by the target's own `parentId`.)*

### Measurement — how `spent` is computed (must reconcile with `aggregate_spending`)

For a budget targeting node `T` in month `[from, to)`, `spent` = sum of `amount` over transactions that are
**`status = 'effective'`**, **`type = 'expense'`**, **`currency = budget.currency`**, dated in the month, and:

- **`T` is a top-level category** → `category_id = T` (rolls up sub-categories — matches `aggregate_spending`).
- **`T` is a sub-category** (`T.parentId` set) → `subcategory_id = T`.

`type = 'expense'`, not merely `!= 'transfer'`: a `both`-kind category is a legitimate budget target (only pure
`income`-kind is rejected — see the expense-eligibility guard below), and `aggregate_spending`/`get_spending_summary`
keep `type` as an explicit output dimension their own callers/shaping code separate income from expense by — `spent`
here is one collapsed scalar with no such dimension, so an income transaction booked to a `both`-kind category would
otherwise inflate a spending cap. Reuse the existing effective-only predicate (the invariant), not a bespoke filter;
the expense-only cut is budgets' own addition on top of it. `get_budget_status`
returns one entry per budget — `{ target (name, kind), currency, limit, spent, remaining: limit - spent,
pct: spent/limit }` — **grouped by category**, so multiple per-currency budgets on the same category read as one
coherent unit (per-currency lines under each category). No cross-currency total is produced. Over-budget
(`spent > limit`) is reported, never an error.

### Write flows (FC/IS — greenfield entity)

`models/budget.ts` (`BUDGET_ENTITY_TAG`, `Budget`, `BudgetEntity` with `version`, `budgetErrors`);
`adapters/budgets.ts` (`modelToDb` + `entityDbAdapter`); `diplomat/db/repos/budgets.ts` (read methods +
`budgetApplier`); `controllers/budgets.ts`; wire schemas; MCP tools. All writes return `{ persist, response }`.

- **`create_budget`** `{ category | subCategory, currency, limit, period? }` → resolves the target via the shared
  `resolveCategorySelection` (reusing the same category/sub resolution transactions use); guards:
  - target resolves (else `unknown_category`/`unknown_sub_category`),
  - target is an **expense-kind** category (a budget caps spending; income categories are rejected —
    `budgetErrors.notExpenseCategory`, reusing the category `kind`),
  - `currency` is valid, `limit > 0`,
  - not a duplicate `(category_id, currency, period)` → `budgetErrors.duplicate`.
- **`update_budget`** — change `limit` (and/or `period`); version-guarded.
- **`delete_budget`** — idempotent by design (unknown id → `{ deleted: false }`, empty batch), mirroring
  `deleteTag`/`delete_dashboard`.
- **`list_budgets`** — the budgets themselves (no spend); `get_budget_status` is the measured view.

**`budgetApplier` = `versionedTableApplier(budgets)` + a unique-conflict wrapper** — `budgets` has the secondary
`UNIQUE(category_id, currency, period)`, so a concurrent create of the same target races into a
`SQLITE_CONSTRAINT_UNIQUE` the id-scoped `onConflictDoNothing` won't swallow; recognise it via
`isUniqueConstraintViolation` and rethrow `VersionConflict` (bounded retry → the domain's own duplicate check
then returns `duplicate`). **Structurally identical to `tagApplier`/`billApplier`** — the same family the
dashboard applier joined, so it's a known shape, not new machinery.

## Options Considered

- **Grain: category-or-sub, category rolls up (chosen)** — falls out of the data model + existing aggregation, no
  special logic; nesting/double-counting is intentional (envelope). Alternative "direct-only category (subs
  excluded)" rejected — inconsistent with `aggregate_spending`, and surprising.
- **Period: recurring monthly limit (chosen)** vs per-specific-month row — recurring avoids monthly re-entry;
  "fresh each period" = per-month measurement, no carryover.
- **Currency: split per-currency flat rows + read-time grouping (chosen)** vs one budget row per category
  holding a currency→limit map (rejected). A currency-less budget is unmeasurable under no-implicit-conversion,
  so currency must be in the identity. The map alternative needs a JSON column or a child limits table — breaking
  the flat versioned-entity shape — for zero functional gain (measurement is per-currency either way, and no
  cross-currency total exists without FX). `get_budget_status` grouping by category recovers the "one Food
  budget" presentation at read time. A true cross-currency total is a **future FX feature** (PLAN open question),
  not a budget-model choice.
- **Target as one `category_id` column (chosen)** vs `category_id`+nullable `subcategory_id` — the single column
  keeps the `UNIQUE` key null-free.

## Docs to update (in the owning phase)

- `docs/architecture.md` — `budgets` in the schema; a budget-measurement invariant (effective-only, expense-only,
  same-currency, category rolls up sub-categories) next to the effective-only balance invariant.
- `docs/write-path.md` — the `budget` entity applier (tag/bill family) in the applier catalogue.
- `docs/mcp-tools.md` — `create_budget`/`update_budget`/`delete_budget`/`list_budgets`/`get_budget_status`.
- `docs/PLAN.md` — Phase 3 budgets checkbox.
- This doc's Implementation status.

## Testing

- **CRUD**: create (category and sub-category targets); duplicate `(target, currency, period)` → `duplicate`;
  income-kind target → `notExpenseCategory`; `limit <= 0` rejected; unknown target → resolve error; update limit
  (version-guarded); delete idempotent (unknown id → `{ deleted: false }`); concurrent same-target create →
  unique-conflict → retry → `duplicate` (mirror `tagApplier` race test).
- **Status**: category budget includes sub-category spend; sub-category budget measures only its own; per-currency
  isolation (BRL budget ignores USD spend); effective-only + transfers excluded + income excluded on a `both`-kind
  category; over-budget reported; empty month → `spent: 0`; spend under a sub counts toward both its budget and
  the parent's.

## Implementation prompt

Two PRs, each behind the full gate. Read `docs/write-path.md` before the applier/flows and
`docs/architecture.md` § Write path guardrails. Both phases are feature-sized (new entity / schema; a measurement
query) → independent verification subagent on each diff.

### Phase 1 — `feat/budgets-crud`
Migration (`budgets` table + `UNIQUE`); `models/budget.ts`; `adapters/budgets.ts`; `diplomat/db/repos/budgets.ts`
(`budgetApplier` = `versionedTableApplier` + unique-conflict wrapper; read methods incl. a `findByTarget` for the
duplicate check); `controllers/budgets.ts` (`create`/`update`/`delete`/`list`, reusing `resolveCategorySelection`
+ the expense-kind guard); wire schemas + `create_budget`/`update_budget`/`delete_budget`/`list_budgets` tools;
`docs/architecture.md` (schema), `docs/write-path.md` (applier), `docs/mcp-tools.md`.

### Phase 2 — `feat/budget-status`
`get_budget_status(month, year)` — a read flow summing effective / expense-only / same-currency spend per budget
with the top-vs-sub target branch, reusing the existing month-range + effective-only predicates; the
`BudgetStatus` result shape; `get_budget_status` tool; the budget-measurement invariant in `docs/architecture.md`;
`docs/mcp-tools.md`; PLAN Phase 3 checkbox.

### Finish (every push, every phase)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing.
