# ADR-008: Pending vs. effective transactions

**Status:** Accepted · **Date:** 2026-06-17 · Extends the transaction model in `docs/architecture.md`.

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
