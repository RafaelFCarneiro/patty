# ADR-028: Read-side cross-aggregate correlation lives in controllers, not repos

**Status:** Accepted · **Date:** 2026-08-07 · **Deciders:** Rafael · A layering decision for the **read
side**, the counterpart to **ADR-016** (bounded-context ownership on the write side) and the diplomat-layering
rules in `docs/diplomatic-architecture.md`. Refines **ADR-011** (safe dynamic aggregation SQL): aggregation
stays in the repo, but *correlation across aggregates* does not. Supersedes the `budgetTargetMatch`
shared-fragment approach introduced with Feature Design 015/016.

## Context

Read/reporting flows that span two aggregates were being implemented as a **single fused SQL join inside one
aggregate's repo**. The clearest case: `get_budget_status` measured spend by joining `budgets ⋈ categories ⋈
transactions` inside `budgetsRepo.status`, with a shared `budgetTargetMatch` SQL fragment correlating a budget's
target to a transaction's `category_id`/`subcategory_id`. Feature Design 020 (pending-aware status) made the
smell more visible by adding a second transaction-status branch to that same repo query.

Two problems, both on the read side:

- **Cross-aggregate correlation in a repo.** `budgetsRepo` knew the `transactions` table shape — status/type
  semantics, the target↔transaction matching rule — so the `budgets` aggregate reached into the `transactions`
  aggregate's internals. This is the same bounded-context leak ADR-016 removed on the write side, now on reads.
  `find_correlations`' `budget_fit` mode does the identical fused join (it even shares `budgetTargetMatch`).
- **Policy duplication.** The transaction "what counts" predicates (`status = 'effective'`, `type = 'expense'`,
  `type != 'transfer'`, and now `status = 'pending'`) are re-expressed as raw SQL across ~6 repos
  (`accounts`, `budgets`, `correlations`, `merchants`, `transactions`). No single home defines "effective
  spend."

The tension: aggregation genuinely **must** happen in SQL (you can't pull every transaction into the domain to
sum it) — that is the repo/shell's job (ADR-011). The question is not *where the SUM runs* but *where the
decision to correlate two aggregates is made*.

## Decision

**A repo is per-aggregate: it queries only its own entity, including aggregations over that entity's own
dimensions. Correlating two aggregates is orchestration, and orchestration is the controller's job; the
matching rule is pure domain logic (`logic/`). No repo joins another aggregate's table to correlate or measure
it.**

Concretely, a cross-aggregate read becomes: each repo returns its own aggregate's data (one already aggregated
over its own dimensions if needed), the **controller** fetches both and hands them to **`logic/`**, which
correlates them and shapes the response.

### Scope — correlation, not label lookups

This governs **cross-aggregate correlation/measurement**, not display joins. A repo may still `LEFT JOIN` a
reference table purely to fetch a referenced row's label material (e.g. a category's `name`/`names` for
localization in logic — post-#170 the name is localized in `logic/`, the join only carries the raw material).
The test is: **is the repo encoding another aggregate's business rule or matching two aggregates' rows
(governed — move to controller), or merely resolving a foreign key's display label (acceptable)?**

### Transaction counting predicates get one home

The transaction "what counts" predicates stop being re-authored as raw SQL in each repo. They live once, as
named composable fragments owned by the transaction db module (e.g. `txPredicates.effective` / `.pending` /
`.committed` / `.expense` / `.nonTransfer`), and any transaction-domain query composes them — the same
single-source principle, applied to status/type that `budgetTargetMatch` was reaching for, but kept inside the
one aggregate that owns transactions rather than shared across aggregates.

### First application — `get_budget_status`

- **`transactions` repo** gains one aggregation over its **own** dimensions: expense spend over `[from, to)`,
  per currency, grouped by `category_id` **and** `subcategory_id`, split into effective/pending sums (composing
  `txPredicates`). It knows nothing of budgets.
- **`budgets` repo** returns budgets only (`list`), as it already does. `budgetTargetMatch` and the fused
  `BUDGET_STATUS_SELECT` join are **removed**.
- **`getBudgetStatus` controller** fetches both (plus `deps.locale()`) and hands them to `logic/budget.ts`,
  which correlates: a **top-level** target sums every spend row whose `category_id` = target (sub-category
  spend rolls up for free — invariant 7 guarantees a sub-category transaction carries its parent as
  `category_id`); a **sub-category** target sums rows whose `subcategory_id` = target. Effective/committed/
  pct/remaining and name localization all compute in `logic/`. The `budgetTargetMatch` rule is now pure code
  over the aggregated rows, not SQL.

## Options Considered

- **Correlation in the controller, aggregation-by-own-dimension in the repo (chosen).** Repos stay
  per-aggregate; the matching rule is testable pure logic; the transaction predicates get one home. Cost: two
  queries + an in-memory correlation instead of one fused join, and slightly more data crosses the boundary
  (spend per category node vs. pre-matched per budget).
- **Single-source the predicates but keep the fused join in the repo (rejected).** Removes the duplication but
  leaves the cross-aggregate correlation — and the `budgets`-knows-`transactions` leak — in the repo. Treats
  the symptom, not the boundary.
- **Relocate the measurement into a `transactions` query the `budgets` repo calls (rejected).** Moves the join
  behind a method but still fuses two aggregates in one query and can just relocate the coupling (now
  `transactions` knows budget targets).
- **Pull raw rows into the controller and sum in JS (rejected).** Honors the boundary but discards SQL
  aggregation — doesn't scale and defeats ADR-011.

## Consequences

- **Repos are provably per-aggregate on the read side.** A repo joining another aggregate's table to correlate
  or measure it is now a reviewable smell, the read-side mirror of ADR-016.
- **The correlation rule is pure and unit-testable** in `logic/`, no DB fixture needed to test the
  target-rollup logic.
- **Aggregation cost:** cross-aggregate reads issue N (usually 2) queries and correlate in memory rather than
  one fused query. Acceptable and deliberate at local single-user scale (perf is a non-issue here); the fused
  join's marginal efficiency is not worth the boundary cost. Revisit only if a real hot path emerges.
- **Migration surface (phased, not one PR):** `get_budget_status` first (this ADR's application);
  `find_correlations`' `budget_fit` mode is the second site of the same fused pattern and migrates next.
  `accounts`/`merchants`/`summary` aggregate over the transaction dimension they already own or do label-only
  joins — they satisfy the convention already or are display-join-only; audit, don't reflexively rewrite.
- **`txPredicates`** becomes the one place the effective/pending/expense/non-transfer rule is defined; changing
  what "effective" means is a one-file edit.

## Migration plan (phased — behind the full gate)

Phases 1–2 land **on the existing `feat/pending-aware-budget-status` branch**, alongside the Feature Design 020
pending-aware change already there — the budget change and the boundary fix ship together rather than as a
merge-then-refactor sequence, so `get_budget_status` reaches `main` already controller-orchestrated (no fused
repo join ever hits `main`). This ADR doc rides the same branch. Phase 3 is a separate follow-up.

1. **Phase 1 (same branch)** — extract the transaction counting predicates into named composable fragments in
   the transaction db module; recompose the existing transaction-domain queries (`aggregate`, `summaryRows`,
   `search`, balance parts, `merchants.top`) onto them. Behavior-preserving; existing integration tests are the
   proof.
2. **Phase 2 (same branch)** — add the transaction spend-by-category-node aggregation (own dimensions,
   status-split, composing `txPredicates`); move the budget target-match into `logic/budget.ts`;
   `getBudgetStatus` orchestrates; delete `budgetTargetMatch` + `BUDGET_STATUS_SELECT`'s transaction join. The
   FD-020 two-measure response contract is preserved (the shape merged on this branch already); tests updated.
3. **Phase 3 (`refactor/budget-fit-controller-correlation`, follow-up)** — apply the same to
   `find_correlations`' `budget_fit` mode; retire the shared `budgetTargetMatch` entirely.

## Action Items

1. [x] Review/accept this ADR (rides `feat/pending-aware-budget-status`).
2. [x] Phase 1 — `txPredicates` single-sourcing (behavior-preserving), same branch.
3. [x] Phase 2 — `get_budget_status` controller-orchestrated correlation; `budgetTargetMatch` removed from
   budgets (relocated, no longer exported, to `diplomat/db/repos/correlations.ts` — its one remaining consumer
   until phase 3); revise Feature Design 020 to the controller-orchestrated shape; update invariant 21 wording —
   same branch.
4. [ ] Phase 3 — `budget_fit` correlation moved to the controller; `budgetTargetMatch` fully retired (follow-up
   branch).
5. [x] Record the read-side correlation convention in `docs/architecture.md` (dependency/layering section) and a
   one-line pointer in `CLAUDE.md` (mirrored to `.github/copilot-instructions.md`).

Each phase is feature-sized (spans repo + controller + logic + tests) → independent verification subagent per
diff, charged specifically with confirming no repo introduced or kept a cross-aggregate correlation join and the
response contract is unchanged.
