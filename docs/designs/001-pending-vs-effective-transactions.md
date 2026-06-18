# Feature Design 001: Pending vs. effective transactions

**Type:** Feature design (not an ADR — a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress (first cut built; correcting date-aware default + recurring provisioning) · **Branch:** `feat/pending-transactions` ·
**Date:** 2026-06-17 · Extends the transaction model in `docs/architecture.md`. The durable invariant this
produces (balances/summaries are effective-only) lands in `docs/architecture.md` when implemented.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

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

Add a **`status`** field to transactions: **`pending | effective`**. The application-level default is
**date-aware** (see (1)); the DB column default is `effective` (a storage fallback for legacy/un-specified rows).

1. **Date-aware default (global, all creation paths).** When `status` is omitted, it is derived from the
   transaction date relative to today: **future-dated → `pending`, today/past → `effective`**. An explicit
   `status` always wins. This applies uniformly to `create_transaction`, `create_transactions_bulk`,
   `create_transfer`, and recurring materialization — one pure helper (`defaultStatusFor(date, clock)`),
   no path hardcodes a status. Common paths become natural: logging yesterday's expense is effective
   automatically; scheduling next month's salary is pending automatically.
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
6. **Recurring provisions forward (the quality-of-life payoff).** `apply_due_recurring` gains an optional
   **`through`** date (default = today). It materializes every occurrence with `date <= through`, and each
   occurrence's status comes from the date-aware default — so past/present months land `effective` and future
   months land `pending`. Passing a future `through` pre-creates the salary/rent/subscription you already
   know is coming, as pending, feeding the projection and saving monthly re-entry. Idempotent per
   `rec-<ruleId>-<date>`, so re-running is safe; `nextDue` advances past the last materialized occurrence.
   Default behaviour (`through = today`) is unchanged catch-up — but now correctly stamps each occurrence via
   the date-aware rule rather than forcing `effective`.

Same-row, same idempotency, same edges (account/category/card/tags) — `status` is one more column.

## Scope / out of scope

- **In:** the `status` column; the **date-aware default helper** applied across all creation paths
  (incl. transfers — no more hardcoded `effective`); effective-only balances/summaries; `projectedAsOf`
  provisioning; the `confirm_transaction` tool; the `status` search filter; **`apply_due_recurring(through?)`
  forward provisioning** (future occurrences as pending).
- **Out (future, not this change):** auto-suggesting confirmation when a pending date passes; a rolling
  auto-horizon for recurring (we use an explicit `through`); Cowork notification wiring (the data model
  enables it, the task itself is separate).

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

- **Schema/migration:** add `status text not null default 'effective'` to `transactions` (the DB default is a
  storage fallback; the application computes the status date-aware before insert). A partial index on
  `(status, date)` supports the scheduling query.
- **Date-aware default helper:** a pure `logic/` helper `defaultStatusFor(date, clock)` (future → `pending`,
  today/past → `effective`) is the single source of the rule, called by every create path; **no controller
  hardcodes a status** (transfers and recurring included).
- **Invariant (new, enforced in review + tests):** balance and spending-summary queries MUST filter
  `status = 'effective'`. Projection queries explicitly include `pending`. Classification ignores status.
- **Recurring is forward-looking:** `apply_due_recurring(through?)` materializes through a horizon date
  (default today), each occurrence stamped via the date-aware helper — past/present `effective`, future
  `pending`. Existing catch-up behaviour is preserved; the only change to old behaviour is that occurrences
  are no longer force-stamped `effective`.
- **MCP surface:** `create_transaction`/`create_transactions_bulk`/`create_transfer` gain optional `status`
  (omitted → date-aware default); new `confirm_transaction`; `search_transactions` gains a `status` filter;
  `get_account_balances` gains optional `projectedAsOf`; `apply_due_recurring` gains optional `through`.
  Documented in `docs/mcp-tools.md`.
- **Diplomatic blast radius:** a model field + the `defaultStatusFor` logic helper + controller/query changes +
  one new tool + the recurring horizon change. `logic/` also gains the pure projection math (effective +
  pending-through-date); no architectural change.
- **Vocabulary:** `pending` and `effective` are the canonical terms (a zod enum exposing `.enum.*`), used
  consistently across model, tools, and docs.

---

## Implementation prompt

> Hand this section to a coding agent to build the feature. The design above is the source of truth; this
> is the execution guide. Work on branch **`feat/pending-transactions`** — do **not** create a new branch;
> `git fetch && git rebase origin/main` first.

> **Correction note:** an earlier version of this prompt said "do not derive status from the date" and the
> first implementation hardcoded `status: effective` in `create_transaction`, `create_transfer`, and recurring.
> That was wrong. The steps below replace it: a **date-aware default applied everywhere**, and **recurring that
> provisions forward**. Apply this on top of the current branch state.

**Before coding**, also read: `CLAUDE.md`, `docs/architecture.md`, `docs/diplomatic-architecture.md`,
`docs/code-style.md`, `docs/code-quality.md`. Skim the current shape of `src/models/transaction.ts`,
`src/diplomat/db/schema.ts`, `src/diplomat/db/repos/transactions.ts`, `src/controllers/transactions.ts`,
`src/controllers/transfers.ts`, `src/controllers/recurring.ts`, `src/controllers/accounts.ts` (balances),
`src/controllers/summary.ts`, `src/logic/recurring.ts`, `src/diplomat/mcp/server.ts`; mirror how **bills**
model their `status` and how `pay_bill` flips it.

### Steps

1. **Model** (`models/transaction.ts`): `TransactionStatus = z.enum(['pending','effective'])` on
   `Transaction`/`TransactionView`/the create draft. Enum members everywhere — never bare strings.
2. **Schema + migration** (`schema.ts` + `drizzle/`): add `status text not null default 'effective'` to
   `transactions`; `npx drizzle-kit generate`. Index `(status, date)`.
3. **Date-aware default helper** (`logic/`): add a pure `defaultStatusFor(date, today)` →
   `date > today ? 'pending' : 'effective'`. Unit-test it (past, today, future, boundary). This is the single
   source of the rule.
4. **Apply the helper to ALL create paths — remove every hardcoded status:**
   - `create_transaction` / `create_transactions_bulk`: optional `status`; when omitted, `defaultStatusFor`.
   - `create_transfer`: **remove the hardcoded `TransactionStatus.enum.effective`** — use `defaultStatusFor`
     (a future-dated scheduled transfer is pending). Explicit `status` still wins.
   - An explicit `status` argument always overrides the default.
5. **`confirm_transaction`** (new tool + controller): flips `pending → effective` by id; mirror `pay_bill`.
   Errors: `unknown_transaction`; if already effective, a clear `validation`/no-op (decide + document).
6. **Recurring provisions forward** (`controllers/recurring.ts`): `applyDueRecurring` takes an optional
   `through` (YYYY-MM-DD), default = today. Materialize every occurrence with `date <= through` (keep the
   bounded loop), and **stamp each via `defaultStatusFor(due, today)`** instead of forcing `effective` — so
   past/present land effective and future land pending. Advance `nextDue` past the last materialized
   occurrence. Idempotency key `rec-<ruleId>-<date>` unchanged (re-runs safe). Expose `through` on the
   `apply_due_recurring` MCP tool; describe it ("materialize through this date; future occurrences are created
   as pending").
7. **Effective-only balances/summaries** (hard invariant): `get_account_balances` and `get_spending_summary`
   MUST filter `status = 'effective'`. Audit every balance/summary SQL.
8. **Projection** (`get_account_balances` optional `projectedAsOf`): also return projected = effective +
   pending dated `<= projectedAsOf`. Pure arithmetic in `logic/`. Effective and projected side by side.
9. **Search** (`search_transactions`): `status` filter so "what's scheduled" = pending by date.

### Tests
- **Unit** (`logic/`): `defaultStatusFor` (past/today/future/boundary); projection math.
- **Integration** (in-process libSQL):
  - create with a future date and no `status` → `pending`; past date → `effective`; explicit `status` wins.
  - balances exclude pending; `projectedAsOf` includes it; summary excludes pending; `confirm_transaction`
    flips it; `search_transactions status:'pending'` lists it.
  - **recurring**: a monthly rule with a past `startDate` and `apply_due_recurring(through = a future month)`
    creates past/present occurrences `effective` and future occurrences `pending`; re-running is idempotent;
    default (`through` omitted) only catches up to today.
- **Gate:** `npm run typecheck && npm test && npm run test:integration && npm run build`.

### Invariants — do not break
- **Date-aware default, applied everywhere, no hardcoded status.** Omitting `status` → `pending` for future
  dates, `effective` for today/past, via the one `defaultStatusFor` helper. Explicit `status` always wins.
- **Balances/summaries are effective-only**; projection is opt-in. Pending never leaks into "now".
- **Recurring default behaviour preserved** (catch-up to today) except occurrences are now stamped date-aware,
  not force-`effective`.
- **Classification ignores status.** Constants over literals (`TransactionStatus.enum.*`).
- **Diplomatic layering**: the status rule + projection math live in `logic/`; SQL in `diplomat/db`;
  orchestration in controllers (`safeTry`); no domain leak into transports.
- **Docs in the same change**: `docs/mcp-tools.md` (status on create, `confirm_transaction`, `projectedAsOf`,
  search `status`, `apply_due_recurring` `through`), `docs/architecture.md` (effective-only invariant + the
  `status` column + date-aware default + recurring provisioning), `CLAUDE.md` data conventions. Leave the rest
  of this design doc as-is — **except** update the **Implementation status** header line (→ `In progress` when
  you start, → `Done` in the commit that the PR merges; `Blocked` + reason if stuck).
- **Out of scope**: Cowork notification wiring; auto-confirm when a pending date passes; a rolling auto-horizon
  for recurring (we use an explicit `through`) — note as follow-ups, don't build.

### Finish
Conventional Commits (`feat(transactions): pending vs effective status` + `test:`/`docs:`),
`git push -u origin feat/pending-transactions`, open a PR targeting `main`. Do not merge; after CI, reply to
review threads with the resolving SHA.
