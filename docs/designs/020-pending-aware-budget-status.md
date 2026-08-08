# Feature Design 020: Pending-aware budget status — committed vs effective

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** Done · **Date:** 2026-08-07 · Revises **Feature Design 015** phase 2
(`get_budget_status`) and **invariant 21** in `docs/architecture.md`. The two-measure change merged first with a
fused repo join; **ADR-028** then moved that correlation out of the repo into the controller **on the same
branch**, so `get_budget_status` reaches `main` already controller-orchestrated (no fused repo join ever lands
on `main`). The locale fix (`fix/budget-status-locale`, #170) is orthogonal and already merged.

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`. **Branch**:
> `feat/pending-aware-budget-status` — carries both the two-measure change and the ADR-028 correlation refactor.

## Context

`get_budget_status(month, year)` today measures each budget's spend as a single scalar over **effective-only**
transactions (`BUDGET_STATUS_SELECT`, `diplomat/db/repos/budgets.ts`: `t.status = 'effective'`), matching the
balance rule (invariant 4) and the phase-2 measurement invariant (invariant 21). Dogfooding surfaced the gap:
a user planning against a budget wants to see **how much of the cap is already earmarked** — effective spend
*plus* pending (expected-but-not-yet-cleared) transactions — not only what has cleared. A budget sitting at 40%
effective but 95% committed is a materially different situation, and today's response hides it.

This is a deliberate change to the effective-only budget invariant, not a bug. The balance surface already
treats pending as an **opt-in overlay** rather than folding it into the cleared number (`projectedAsOf` on
`get_account_balances`); budget status should do the same — report both figures side by side so neither is
lost.

## Decision

`get_budget_status` reports each budget against its limit on **two measures**:

- **effective** — cleared spend (`status = 'effective'`): the amount that has actually hit the ledger.
- **committed** — effective **+** pending (`status IN ('effective','pending')`): the amount earmarked against
  the cap.

`pending` (committed − effective) is derivable and surfaced for convenience. Each measure carries its own
`amount`, `pct` (amount / limit), and the shared `remaining` is reported against **committed** (the
earmark-aware headroom), with effective headroom derivable as `limit − effective`. Over-budget stays reported
as-is (pct can exceed 1, remaining can go negative) — never clamped, never an error, same as today.

Nothing else about budgets changes: still per-(target, currency, period), still no cross-currency total, still
`type = 'expense'`-only (a `both`-kind category's income must not offset the cap — the same reason invariant 21
filters `type`, now applied to both status buckets).

### Data shape

`BudgetStatusLine` (and the flat `BudgetStatusEntry` it derives from) replace the single `spent`/`remaining`/
`pct` triple with the two-measure shape. Proposed wire/out (final naming settled in the model):

```
{
  id, currency, period, subCategory?,
  limit,
  effective: { amount, pct },      // status = 'effective'
  committed: { amount, pct },      // status IN ('effective','pending')  (effective + pending)
  pending:   { amount, pct },      // committed - effective (convenience)
  remaining                        // limit - committed.amount  (earmark-aware headroom)
}
```

`remaining` stays a single top-level number (not per-measure) to keep the common "how much room is left"
read one field; effective headroom is `limit − effective.amount` for any client that wants it.

### Where each concern lives (diplomatic layering — as-built under ADR-028)

The two-measure change first shipped as a fused repo join (`BUDGET_STATUS_SELECT` broadened to
`status IN ('effective','pending')` with conditional sums). **ADR-028 then moved the cross-aggregate
correlation out of the repo**, so the as-built layering is:

- **`transactions` repo** — owns one aggregation over its **own** dimensions: expense spend over `[from, to)`,
  per currency, grouped by `category_id` **and** `subcategory_id`, split into effective/pending sums (composing
  `txPredicates`). Knows nothing of budgets.
- **`budgets` repo** — returns budgets only (`list`). `budgetTargetMatch` and the transaction join are removed.
- **Controller (`controllers/budgets.ts`)** — `getBudgetStatus` fetches the two datasets (+ `deps.locale()`)
  and hands them to logic; this is where the two aggregates are correlated (orchestration).
- **Logic (`logic/budget.ts`)** — the target-match rule is pure code over the aggregated rows: a top-level
  target sums rows whose `category_id` = target (sub-category spend rolls up via invariant 7), a sub-category
  target sums rows whose `subcategory_id` = target. It splits `spent` into `spentEffective`/`spentPending`,
  computes `pct`/`remaining` for both measures, and localizes names — all where the single `spent/limit`
  computation already lived (`groupStatusByCategory`/`rowToStatusEntry`/`toStatusLine`, reshaped to consume the
  correlated data rather than pre-matched repo rows).

### Interaction with the locale fix

`fix/budget-status-locale` (separate PR) makes `BUDGET_STATUS_SELECT` also select the `names` JSON and moves
display-name localization into the domain (the `logic/correlations.ts` pattern). This feature and that fix both
touch `BUDGET_STATUS_SELECT` and `dbToStatusEntry`/`toStatusLine`; whichever lands second rebases onto the
other. They're kept as separate PRs because one is a bug fix (parity, no invariant change) and one revises a
documented invariant — but the author should sequence them back-to-back to avoid a churny double-touch of the
same query.

## Options considered

- **Two measures side by side (chosen)** vs replacing `spent` with committed — replacing would hide the
  cleared-vs-earmarked distinction that motivated this and silently change the meaning of an existing field.
  Side-by-side preserves the effective number and adds the committed view, mirroring `projectedAsOf`.
- **Conditional aggregation in one query (chosen)** vs two queries / two repo methods — one pass over the same
  join is cheaper and keeps the effective and committed numbers consistent by construction (same WHERE, same
  matched rows). Two queries could drift and doubles the work.
- **`remaining` against committed (chosen)** vs against effective vs both — committed is the planning-relevant
  headroom (what's left after earmarks); effective headroom is trivially derivable, so exposing only the
  committed one keeps the payload lean. Revisit if a client needs both first-class.

## Docs to update (same change)

- `docs/architecture.md` invariant 21 — revise the "effective-only" measurement clause to "reports effective
  and committed (effective + pending) against the limit"; keep the `type = 'expense'` and per-currency clauses.
- `docs/designs/015-budgets.md` — mark phase 2's measurement superseded by this design; link here.
- `docs/mcp-tools.md` — the `get_budget_status` response schema (the new two-measure shape).
- PLAN — note under budgets if a status line tracks it.

## Testing

- **Logic (`test/unit/logic/budget.test.ts`)** — `toStatusLine` derives correct `pct`/`remaining` for both
  measures from raw sums: effective-only (pending = 0), mixed, over-budget on committed but under on effective,
  zero-limit guard behavior consistent with today.
- **Integration (`test/integration/…` budget status)** — seed effective + pending + future-dated-defaulted-
  pending transactions on a target; assert effective sums cleared-only, committed adds pending, transfers and
  income-on-`both` excluded from both, per-currency separation intact.
- Success **and** expected-failure paths per the DoD.

## Implementation prompt

One PR, `feat/pending-aware-budget-status`, behind the full gate (CLAUDE.md DoD: self-review + gate +
subagent verification — this touches the schema/model surface + a measurement invariant, so it's
feature-sized).

- Repo: broaden `BUDGET_STATUS_SELECT` to `status IN ('effective','pending')` with conditional sums for
  effective and pending (one pass); `dbToStatusEntry` maps both.
- Model/wire: replace the single `spent`/`remaining`/`pct` with the two-measure shape (effective/committed/
  pending + top-level `remaining`); update `BudgetStatusEntrySchema`/`BudgetStatusLineSchema`.
- Logic: `toStatusLine` derives both pcts + remaining; `groupStatusByCategory` unchanged except the line shape.
- Docs: invariant 21, FD-015 phase 2 supersede note, `docs/mcp-tools.md`.
- Sequence back-to-back with `fix/budget-status-locale` to avoid a double-touch of `BUDGET_STATUS_SELECT`.
