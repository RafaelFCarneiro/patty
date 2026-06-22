# Feature Design 005: Delete category / sub-category (block-if-in-use)

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Not started · **Branch:** `feat/delete-categories` (suggested) ·
**Date:** 2026-06-21 · Touches the category surface in `docs/architecture.md` / `docs/mcp-tools.md`.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

Categories and sub-categories can be created (`create_category`, `create_sub_category`) but never deleted —
a gap in the taxonomy lifecycle. Deleting a category is **not** a clean delete: `categories.id` is referenced by

- `transactions.category_id` / `subcategory_id` (nullable) — **user records**,
- `recurring_rules.category_id` (nullable) — **user records**,
- `categories.parent_id` (self-ref — a category's **sub-categories**) — **user records**,
- `merchant_category.category_id` (**NOT NULL** — the learned classification weights) — **derived data**.

with a CHECK that `subcategory_id` set ⇒ `category_id` set. A category is a *classification*, not an owner of
its transactions, so deletion must **never** cascade into transactions (unlike `delete_credit_card`). The split
that matters: **user records block; derived data is cleaned up.** Transactions, recurring rules, and
sub-categories are user records — they block the delete. `merchant_category` rows are *learned, re-learnable*
data tied to the category (and NOT NULL, so they'd FK-block anyway) — they are **removed with the category**, not
a blocker.

## Decision

1. **Block if in use by user records.** `delete_category` / `delete_sub_category` delete the row **only when no
   user records reference it** — i.e. no transaction, recurring rule, or sub-category. If any do, return a
   structured **`in_use`** error listing the reference counts; delete nothing. The user reassigns/clears first
   (e.g. `update_transaction` to recategorize, `delete_sub_category` for children), then retries. **Merchant
   rules do NOT block** (Decision 4).
2. **Merchant rules are removed with the category (not a blocker).** On a successful delete, the category's
   `merchant_category` rows are deleted as part of the same operation (required anyway by the NOT NULL FK). They
   are learned, re-learnable weights — losing them only means those merchants won't auto-classify until
   re-learned; no user data is lost. (Reassigning them to a target category is the job of the deferred
   reassign-on-delete follow-up — "reallocate or delete"; v1 deletes them.)
3. **No reassign, no uncategorize for user records, no cascade into transactions.** We never move/null/delete
   transactions or recurring rules — those block instead. The only thing removed besides the category row is its
   derived merchant rules (Decision 2).
4. **Seeded categories are deletable (ADR-008).** The 15 default slugs aren't specially protected — seed is
   optional. A seeded category whose *only* references are its seeded merchant rules **deletes successfully**
   (those rules are removed with it). It is blocked only by real **user records** (transactions, recurring,
   sub-categories), like any category.
5. **Atomic, but no dry-run/confirm.** The delete removes the merchant rows + the category row in **one
   transaction** (`db.transaction`) so it can't half-apply. It still needs **no** two-step confirm: user records
   block it, and the only thing it removes is the unreferenced category plus its re-learnable derived rules —
   unlike the destructive `delete_transaction` / `delete_credit_card`. The tool description states that deleting
   a category also drops its learned merchant rules.
6. **Blocking references checked (for category `C`):** `transactions` where `category_id = C` OR `subcategory_id
   = C`; `recurring_rules` where `category_id = C`; `categories` where `parent_id = C` (its sub-categories).
   `merchant_category` is **not** in the blocking set (it's cleaned up, Decision 2). For a **sub-category `S`**
   the same user-record sources are checked (`parent_id = S` defensively, though sub-categories don't nest).
7. **`in_use` error shape:** `{ code: 'in_use', entity: 'category' | 'sub_category', name, references: {
   transactions, recurring, subCategories } }` — only the *blocking* (user-record) references; the agent reads
   it and guides the user on exactly what to clear.

## Scope / out of scope

- **In:** `delete_category` / `delete_sub_category` controllers + repo reference-count checks; the `in_use` error
  code (+ `docs/mcp-tools.md` error table); MCP tools + REST routes; name resolution via existing
  `resolveCategoryRef` / `resolveSubCategoryRef`; tests.
- **Out:** reassign-on-delete (`reassignTo` target) — a noted follow-up; soft archive/disable of categories;
  cascade delete; bulk delete; deleting tags/accounts (separate). No schema change (no new columns; FKs already
  exist).

## Options Considered

### Block-if-in-use (by user records) — **chosen**
**Pros:** safe and simple — never touches user records (transactions/recurring/sub-categories block instead);
the only thing removed besides the category is its derived, re-learnable merchant rules; no confirm needed; the
`in_use` error tells the agent exactly what blocks it. Smallest safe surface.
**Cons:** not one-shot — the user must clear user-record references first; deleting a category drops its learned
merchant weights (re-learnable, and stated in the tool description). Acceptable; the error makes the next step
obvious.

### Reassign-or-uncategorize (dry-run/confirm) — deferred follow-up
**Pros:** one-shot graceful delete (move refs to a target, or uncategorize).
**Cons:** more surface (a `reassignTo`, a dry-run/confirm flow, silent history changes when uncategorizing). Not
needed for v1; can layer on later as `reassignTo` without changing the block default.

### Always-uncategorize — rejected
Silently de-categorizes historical transactions and drops learned weights with no migrate path. Wrong default
for a finance tool.

> Note vs. `delete_tag`: tags cascade their associations on delete because a tag is a free-form label with no
> classification semantics. A category carries categorization + merchant learning, so block-if-in-use (not
> cascade) is the right policy here.

## Consequences

- **New:** `deleteCategory` / `deleteSubCategory` controllers (`safeTry`, return `ResultAsync`); repo methods to
  count **blocking** references (transactions, recurring, sub-categories) and an atomic delete (merchant rows +
  category row in one `db.transaction`); the `in_use` `AppError` variant; MCP tools + REST routes;
  `docs/mcp-tools.md` entries + the new error code; mention in `docs/architecture.md` if the error union is
  documented there.
- **Reuse:** `resolveCategoryRef` / `resolveSubCategoryRef` (locale-aware, ADR-009) for name → entity.
- **No schema/migration** — purely additive behavior over existing FKs.
- **Blast radius:** additive — category controller + repo + two edges + docs. No change to existing tools,
  balances, classification, or transactions.

---

## Implementation prompt

> Hand this to a coding agent. The design above is the source of truth. Work on branch
> **`feat/delete-categories`** off `main`; `git fetch && git rebase origin/main` first. Read `CLAUDE.md` (esp.
> the **Definition of Done**), `docs/architecture.md`, `docs/code-style.md`, `docs/code-quality.md`. Mirror the
> existing category surface: `src/controllers/categories.ts`, `src/diplomat/db/repos/categories.ts`,
> `src/controllers/resolve.ts` (`resolveCategoryRef` / `resolveSubCategoryRef`), `src/common/errors.ts` (the
> `AppError` union + `delete_transaction`'s shape for reference), `src/diplomat/mcp/server.ts`, and
> `src/diplomat/http/routes.ts`.

### Steps

1. **Error code** (`common/errors.ts`): add an `in_use` `AppError` variant carrying `entity`
   (`'category' | 'sub_category'`), `name`, and a `references` breakdown of the **blocking** sources only —
   `{ transactions, recurring, subCategories }` (no `merchantRules`). Map it to a sensible HTTP status (409
   Conflict).
2. **Repo** (`diplomat/db/repos/categories.ts`): a `countReferences(categoryId)` returning the three **blocking**
   counts (parameterized `COUNT(*)` over `transactions` [`category_id` OR `subcategory_id`], `recurring_rules`,
   and `categories.parent_id`). And a `delete(categoryId)` that, in **one `db.transaction`**, deletes the
   category's `merchant_category` rows (`WHERE category_id = id`) and then the `categories` row — atomic so it
   can't half-apply. (`merchant_category` is intentionally NOT in the count — it's cleaned up, not a blocker.)
3. **Controllers** (`controllers/categories.ts`): `deleteCategory(name)` and `deleteSubCategory(name)` —
   resolve via `resolveCategoryRef` / `resolveSubCategoryRef`; `countReferences`; if any blocking count > 0,
   `yield*` an `in_use` error with the counts; else call the repo delete (which removes the merchant rules + the
   category atomically). `safeTry`, `ResultAsync`. No confirm flag.
4. **Surface:** `delete_category` / `delete_sub_category` MCP tools (input `name`; description explains
   block-if-in-use by transactions/recurring/sub-categories, **and that deleting also removes the category's
   learned merchant rules**) + REST `DELETE` routes. Mirror the thin-diplomat pattern.
5. **Constants over literals**; reuse enum members; keep `logic/` out of it (pure orchestration + count/delete
   queries, no pure-logic computation needed).

### Tests
- **Integration** (in-process libSQL): (a) a user category with no references → `delete_category` succeeds and
  it's gone from `list_categories`; (b) a category used by a transaction → `in_use` error with
  `references.transactions ≥ 1`, category still present; (c) a parent with a sub-category → `in_use` with
  `references.subCategories ≥ 1`; (d) a category whose **only** reference is a merchant rule (e.g. a seeded
  default with no transactions) → `delete_category` **succeeds**, and that `merchant_category` row is gone
  afterward (proves merchant rules are removed, not a blocker); (e) `delete_sub_category` blocked while a
  transaction uses it, succeeds once unreferenced; (f) unknown name → `unknown_category` /
  `unknown_sub_category`.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **Never cascade into transactions/recurring** — those are user records and *block* the delete; a category
  delete removes only the category row and its derived `merchant_category` rows.
- **Block-if-in-use by user records** is the contract: a category/sub-category referenced by a transaction,
  recurring rule, or sub-category is never deleted; `in_use` is returned. **Merchant rules never block** — they
  are removed with the category (atomically).
- **Seeded categories follow the same rule** (no special protection; blocked only by user-record references —
  their seeded merchant rules are cleaned up, not a blocker).
- **Atomic delete**: merchant-rule removal + category removal happen in one `db.transaction`.
- **Diplomatic layering**: resolution + orchestration in the controller; parameterized count/delete in
  `diplomat/db`; thin diplomats; zod at boundaries; constants over literals.
- **Docs in the same change:** `docs/mcp-tools.md` (the two tools + the `in_use` error code), and the
  `AppError`/error-code list wherever it's documented.
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push. Small, single-area change — the
  inline self-review suffices (not feature-sized enough to require the subagent pass, though it won't hurt).

### Finish
Conventional Commits (`feat(categories): delete_category / delete_sub_category (block-if-in-use)` + `test:`/
`docs:`), `git push -u origin feat/delete-categories`, open a PR targeting `main`. Run the Definition of Done;
do not merge; after CI, reply to review threads with the resolving SHA.

## Deferred follow-up

- **Reassign-on-delete:** an optional `reassignTo` that moves references to a target category (behind dry-run/
  confirm), for a one-shot graceful delete — layers on top without changing the block default.
- **Soft archive/disable:** hide a category from new use while preserving history (parallels the card
  enable/disable follow-up).
