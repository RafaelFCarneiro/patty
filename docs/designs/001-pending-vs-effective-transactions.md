# Feature Design 001: Pending vs. effective transactions

**Type:** Feature design (not an ADR — a feature + technical assessment) · **Status:** Accepted ·
**Date:** 2026-06-17 · Extends the transaction model in `docs/architecture.md`. The durable invariant this
produces (balances/summaries are effective-only) lands in `docs/architecture.md` when implemented.

## Context

Every transaction today is implicitly **already happened** — it counts toward balances and spending
summaries the moment it is created. There is no way to record money that is **expected but not yet real**:
a salary that lands next month, the rent you know you'll pay, a subscription that hasn't been charged yet.

Users want to model these to answer two different questions:

1. **What is true now?** — my actual, cleared balance and what I actually spent.
2. **What is coming?** — a *provisioning* view: where will I stand once known future income and expenses
   land, through a given date.

They also want to query **what is scheduled for a day** (e.g. to drive a Cowork notification task).

This is distinct from `recurring_rules` (templates that *materialize* transactions on a schedule) and from
`bills` (which already have their own `open|closed|paid` lifecycle). It is a property of an individual
transaction: has it cleared yet, or is it still expected?

## Decision

Add a **`status`** field to transactions: **`pending | effective`**, default **`effective`**.

1. **Default `effective`.** Logging a transaction means it happened; the common path is unchanged. A caller
   opts into a forecast by passing `status: 'pending'` (e.g. "I'll get my salary on the 5th"). Status is
   **explicit**, not derived from the date — predictable over clever.
2. **Effective-only by default everywhere that means "now".** `get_account_balances` and
   `get_spending_summary` count **only `effective`** transactions. The real balance and "what I spent" are
   never polluted by expectations. This is a hard invariant (see below).
3. **Projection is opt-in.** A *provisioning* view answers "what is coming": effective balance **plus**
   pending transactions dated on/before a chosen `asOf` date. Exposed by extending `get_account_balances`
   with an optional `projectedAsOf` (returns effective and projected side by side) — never as the default.
4. **Explicit clearing.** A pending transaction becomes effective only via an explicit
   **`confirm_transaction`** action (pending → effective), mirroring `pay_bill`. It is never auto-flipped by
   the passage of its date — scheduled is not the same as happened.
5. **Scheduling query.** Pending transactions are queryable by date/status (`search_transactions` gains a
   `status` filter), which is what a "what's due today" notification task calls.

Same-row, same idempotency, same edges (account/category/card/tags) — `status` is one more column.

## Scope / out of scope

- **In:** the `status` column, effective-only balances/summaries, `projectedAsOf` provisioning, the
  `confirm_transaction` tool, the `status` search filter, transfers and card transactions may be pending too.
- **Out (future synergy, not this change):** having `apply_due_recurring` materialize the next *N*
  occurrences **as pending** for richer provisioning; auto-suggesting confirmation when a pending date passes;
  Cowork notification wiring (the data model enables it, the task itself is separate).

## Options Considered

### Option A — `status: pending | effective`, effective-only by default — **chosen**
**Pros:** clean separation of real vs. expected; the default path is unchanged; one column, one lifecycle
verb (`confirm`); provisioning is an explicit, well-bounded view.
**Cons:** every balance/summary query must remember to filter `status = 'effective'` (mitigated: enforced as
an invariant + covered by tests).

### Option B — pending affects balances immediately
**Pros:** simplest; no projection concept.
**Cons:** blurs "how much do I actually have" with "how much will I have"; a forecast error silently
corrupts the real balance. Rejected.

### Option C — model expectations only as recurring rules
**Pros:** reuses existing machinery.
**Cons:** recurring rules are repeating templates; one-off expectations (a bonus, a one-time bill) don't fit,
and rules don't carry a per-occurrence cleared/uncleared state. Rejected — these are orthogonal concepts.

## Consequences

- **Schema/migration:** add `status text not null default 'effective'` to `transactions`; existing rows
  become `effective` (correct — they already happened). A partial index on `(status, date)` supports the
  scheduling query.
- **Invariant (new, enforced in review + tests):** balance and spending-summary queries MUST filter
  `status = 'effective'`. Projection queries explicitly include `pending`. Classification ignores status.
- **MCP surface:** `create_transaction`/`create_transactions_bulk` gain optional `status` (default
  `effective`); new `confirm_transaction`; `search_transactions` gains a `status` filter; `get_account_balances`
  gains optional `projectedAsOf`. Documented in `docs/mcp-tools.md`.
- **Diplomatic blast radius:** a model field + controller/query changes + one new tool. `logic/` gains the
  pure projection math (effective + pending-through-date); no architectural change.
- **Vocabulary:** `pending` and `effective` are the canonical terms (a zod enum exposing `.enum.*`), used
  consistently across model, tools, and docs.

---

## Implementation prompt

> Hand this section to a coding agent to build the feature. The design above is the source of truth; this
> is the execution guide. Work on branch **`feat/pending-transactions`** — do **not** create a new branch;
> `git fetch && git rebase origin/main` first.

**Before coding**, also read: `CLAUDE.md`, `docs/architecture.md`, `docs/diplomatic-architecture.md`,
`docs/code-style.md`, `docs/code-quality.md` (diplomatic layering, `safeTry` controllers, constants over
literals via zod `.enum.*`, zod at boundaries, remeda for ≥2-stage transforms). Skim the current shape of
`src/models/transaction.ts`, `src/diplomat/db/schema.ts`, `src/diplomat/db/repos/transactions.ts`,
`src/controllers/transactions.ts`, `src/controllers/accounts.ts` (balances), `src/controllers/summary.ts`,
`src/diplomat/mcp/server.ts`; mirror how **bills** model their `status` and how `pay_bill` flips it.

### Steps

1. **Model** (`models/transaction.ts`): add `TransactionStatus = z.enum(['pending','effective'])` and a field
   on `Transaction`/`TransactionView`/the create draft. Use the enum members everywhere — never bare strings.
2. **Schema + migration** (`schema.ts` + `drizzle/`): add `status text not null default 'effective'` to
   `transactions`; `npx drizzle-kit generate`. Existing rows become `effective` (correct). Add an index on
   `(status, date)` for the scheduling query.
3. **Create paths** (`create_transaction`, `create_transactions_bulk`): optional `status`, default `effective`.
   Status is explicit — do **not** derive it from the date. Transfers and card transactions may be pending too.
4. **`confirm_transaction`** (new tool + controller): flips `pending → effective` by id; mirror `pay_bill`.
   Errors: `unknown_transaction`; if already effective, return a clear `validation`/no-op (decide + document).
   Pure `safeTry` controller.
5. **Effective-only balances/summaries** (hard invariant): `get_account_balances` and `get_spending_summary`
   queries MUST filter `status = 'effective'`. Audit every balance/summary SQL.
6. **Projection** (`get_account_balances` gains optional `projectedAsOf: YYYY-MM-DD`): when present, also
   return projected = effective + pending dated `<= projectedAsOf`. Pure arithmetic in `logic/`, not the repo.
   Return effective and projected side by side; never replace the effective default.
7. **Search** (`search_transactions`): add a `status` filter so "what's scheduled" = pending by date.

### Tests
- **Unit** (`logic/`): projection math — effective + pending-through-date; boundary dates; empty cases.
- **Integration** (in-process libSQL): create an effective + a pending income; assert balances exclude
  pending, `projectedAsOf` includes it, summary excludes pending, `confirm_transaction` flips it (then it
  counts), and `search_transactions status:'pending'` lists it.
- **Gate:** `npm run typecheck && npm test && npm run test:integration && npm run build` (all green).

### Invariants — do not break
- **Default `effective`** — existing create path and tests behave unchanged.
- **Balances/summaries are effective-only**; projection is always opt-in via an explicit param. Pending never
  leaks into "now".
- **Classification ignores status.** Constants over literals (`TransactionStatus.enum.*`).
- **Diplomatic layering**: SQL in `diplomat/db`; orchestration in controllers (`safeTry`); projection math in
  `logic/`; no domain leak into transports.
- **Docs in the same change**: `docs/mcp-tools.md` (status on create, `confirm_transaction`, `projectedAsOf`,
  search `status`), `docs/architecture.md` (the effective-only invariant + the `status` column), `CLAUDE.md`
  data conventions. Leave this design doc as-is.
- **Out of scope**: recurring rules materializing pending occurrences; Cowork notification wiring; auto-confirm
  on date pass — note as follow-ups, don't build.

### Finish
Conventional Commits (`feat(transactions): pending vs effective status` + `test:`/`docs:`),
`git push -u origin feat/pending-transactions`, open a PR targeting `main`. Do not merge; after CI, reply to
review threads with the resolving SHA.
