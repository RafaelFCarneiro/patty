# Feature Design 016: `find_correlations` — spending shifts, recurring candidates, merchant concentration

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress (Phase A done — `spending_shifts`) · **Date:** 2026-07-25 · PLAN Phase 3 (insights) — the "differentiator"
analysis tool. **Read-only** (no entity, no write flow); a later phase with a caller-selected SQL shape (e.g. a
groupBy-style dimension) would reuse the ADR-011 whitelist pattern — Phase A's query shape is fixed, so it needs
no fragment map; respects the effective-only + per-currency invariants.

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`.
> **Four sequential PRs**, one analysis each, off `main`: `feat/correlations-spending-shifts` (A) →
> `feat/correlations-recurring-candidates` (B) → `feat/correlations-merchant-concentration` (C) →
> `feat/correlations-budget-fit` (D).

## Context

PLAN lists `find_correlations` as one tool spanning four analyses. Scoped here to **four** modes (co-occurring
categories dropped — the fuzziest signal, least actionable, "same-day basket" is mostly coincidence):

- **A. Spending pattern shifts** — what's up/down vs a baseline. The PLAN exit criterion ("what's driving the
  change").
- **B. Recurring candidates** — regular-cadence merchants not yet set up as recurring rules. **Depends on
  Feature Design 017** (recurring rules carry a merchant) for an *exact* exclusion.
- **C. Merchant concentration** — where, within a category, the money actually goes (the concrete reading of
  "merchant clusters", see below).
- **D. Budget fit** — does each budget make sense against the actual spending pattern, and what would a realistic
  limit be. Correlates the shift analysis (A) with the budgets entity (Design 015).

All four are **read-only** over `transactions` (which carry `merchant_key`, `category_id`, `subcategory_id`,
`date`, `amount`, `currency`, `type`, `status`), reusing the effective-only / `type = 'expense'` / no-transfer
predicates so figures reconcile with `aggregate_spending`/`get_spending_summary`, and grouped **per currency**
(no cross-currency mixing).

## Decision

### One tool, `analysis` discriminator (mirrors `aggregate_spending`)

`find_correlations({ analysis, period?, ...analysis-specific })` where `analysis` is a whitelisted enum
(`spending_shifts | recurring_candidates | merchant_concentration | budget_fit`). Each mode returns its **own**
result shape
(a discriminated union on `analysis`). Adding a mode later is additive and whitelist-guarded — the same safe
dynamic-SQL discipline as `aggregate_spending` (ADR-011): enum→fragment maps, parameter binding, never
client-supplied SQL. It is a read controller (`controllers/analysis.ts` or `controllers/correlations.ts`)
returning a plain result — no `FlowOutcome`, no applier.

### A — Spending pattern shifts

- **Params:** `month`, `year` (the reference period), `baselineMonths` (trailing window, default **3**),
  `minDeltaPct` (surface threshold, default e.g. **20**).
- **Computation:** per (category, currency), `current` = the reference month's effective expense total;
  `baseline` = the average monthly total over the preceding `baselineMonths`; `delta = current - baseline`,
  `deltaPct = delta / baseline`. Surface categories where `|deltaPct| >= minDeltaPct` (or all, sorted by
  `|deltaPct|` — return sorted, let the caller threshold). Category rolls up sub-categories (same as budgets /
  `aggregate_spending`, via `category_id`).
- **Result:** `[{ category, currency, current, baseline, deltaPct, direction: 'up'|'down' }]`.
- **SQL:** monthly category aggregates over the window; window/aggregate functions for the trailing average. A
  new category with no baseline (`baseline = 0`) is reported as `direction: 'up'`, `deltaPct: null` (a
  new-spend flag, not a divide-by-zero).

### B — Recurring candidates

- **Params:** `lookbackMonths` (default **6**), `minOccurrences` (default **3**), tolerance constants (cadence
  ±days, amount ±%).
- **The SQL/logic split (deliberate):** the repo fetches, per `merchant_key`, that merchant's effective expense
  series (`date`, `amount`, `category`) over the lookback; **cadence detection lives in `logic/` as a pure,
  unit-tested function** (`detectRecurringCadence(series)`), not in SQL — regular-interval detection is far
  cleaner and more testable as pure code than as a window-function contortion, and it fits the functional-core
  rule. It flags a merchant as a candidate when it has `>= minOccurrences` at a consistent ~monthly gap (within
  tolerance) and stable amount (within tolerance), producing `{ merchant, typicalAmount, currency, category,
  cadence: 'monthly', occurrences, lastDate, suggestedNextDue }`.
- **"Not already a rule" is an exact merchant match — via Feature Design 017.** 017 adds `recurring_rules
  .merchant_key`, so a candidate `merchant_key` that already has a rule is excluded exactly. **017 is a
  prerequisite for this phase**; without it the exclusion would fall back to a loose (category+amount) match, so
  land 017 first. Returned items are still framed as *suggestions* (the AI confirms via `create_recurring`).
- **Result:** `[{ merchant, typicalAmount, currency, category, occurrences, lastDate, suggestedNextDue }]` — each
  a ready-to-confirm `create_recurring` shape.

### C — Merchant concentration (the concrete "merchant clusters")

**Pinning down a fuzzy ask, explicitly.** "Merchant clusters" has no clean SQL definition as literal clustering
(that's ML-shaped) and co-visitation is the same coincidental-basket noise co-occurring-categories was dropped
for. The useful, well-defined reading is **spend concentration within a category**: for a period, per category,
the top merchants by spend, each merchant's share, and the cumulative share — answering "where within Food is my
money actually going?" *(If you meant literal behavioural clustering or merchant co-visitation instead, this is
the decision to flip — but I'd argue concentration is the actionable version.)*

- **Params:** `month`, `year`, optional `category` filter, `topN` (default **5**).
- **Computation:** per (category, currency), group effective expense by `merchant_key`, `spent` per merchant,
  `share = spent / categoryTotal`, `cumulativeShare` (window), top `N` + an "others" remainder.
- **Result:** `[{ category, currency, categoryTotal, merchants: [{ merchant, spent, share, cumulativeShare }],
  othersSpent }]`.

### D — Budget fit (correlate spending pattern with budgets)

Closes the loop between insights and budgets: does each budget make sense against how the user actually spends,
and what would a realistic limit be. **Read-only** — the create/update is done by the AI driving the **existing**
`create_budget`/`update_budget` with the returned suggestion, not a bespoke write here (`find_correlations` stays
read-only).

- **Params:** `month`, `year`, `baselineMonths` (default **3**), `slackPct`/`overPct` verdict thresholds.
- **Computation:** reuse A's per-category current + trailing baseline, joined to the budgets (`list` +
  `get_budget_status` territory), **per currency** (a budget's currency must match the spend it's compared to):
  - **Existing budgets** — for each `(category, currency)` budget: `limit`, `current`, `baseline`, and a
    `verdict` — `realistic` (baseline ≈ limit), `tight`/`unrealistic` (baseline materially over limit;
    consistently over-budget), `generous` (baseline well under limit) — plus a `suggestedLimit` (e.g. baseline
    rounded, or baseline + a small margin).
  - **Unbudgeted significant spend** — `(category, currency)` with material spend but **no** budget → a
    *create* suggestion with a `suggestedLimit`.
- **Result:** `{ budgeted: [{ category, currency, limit, current, baseline, verdict, suggestedLimit }],
  unbudgeted: [{ category, currency, baseline, suggestedLimit }] }`. The AI presents these and, on the user's
  say-so, calls `update_budget` / `create_budget` with the suggested value — no new write path.
- **Depends on A** (reuses the shift baseline) and the budgets entity (Design 015).

## Options / decisions

- **Scope: 4 modes, co-occurring categories dropped** — noisiest, least actionable.
- **`budget_fit` stays read-only; create/update reuse the existing budget tools (chosen)** — the mode returns a
  `suggestedLimit`; the AI applies it via `create_budget`/`update_budget`. Rejected: a bespoke "apply
  suggestion" write inside `find_correlations` (would make an analysis tool a writer, duplicate budget CRUD, and
  break the read-only shape). A future bulk "apply all suggestions" convenience could exist, but it's just the
  existing tools in a loop.
- **One tool + `analysis` discriminator (chosen)** vs three separate tools — PLAN names one `find_correlations`;
  the `aggregate_spending` whitelist precedent and a single discriminated-union result keep it consistent and
  additive. (Separate tools were the alternative; rejected for consistency, but the modes stay cleanly
  separable internally.)
- **"Merchant clusters" → merchant concentration (chosen)** — the buildable, actionable reading; literal
  clustering / co-visitation rejected as fuzzy. **Flagged for your confirmation.**
- **Recurring cadence in `logic/`, not SQL (chosen)** — pure, testable; SQL only fetches the per-merchant series.
- **"Already a rule" loose match (accepted limitation)** — no `merchant_key` on rules; candidates are
  suggestions.

## Docs to update (per phase)

- `docs/mcp-tools.md` — `find_correlations` with the `analysis` enum, per-mode params, per-mode result shapes,
  examples.
- `docs/architecture.md` — the analysis is read-only + whitelisted (ADR-011 family); note the effective-only /
  per-currency reuse; the recurring-candidate "suggestion, loose rule-match" caveat if it warrants a line.
- `docs/PLAN.md` — Phase 3 `find_correlations` progress.
- This doc's Implementation status per phase.

## Testing

- **A:** category up/down beyond threshold surfaced with correct `deltaPct`; new category (no baseline) →
  `deltaPct: null`, `up`; per-currency isolation; effective-only / transfers excluded; empty reference month.
- **B:** a clean monthly series → candidate with right `typicalAmount`/`cadence`/`suggestedNextDue`; irregular
  gaps → not a candidate; below `minOccurrences` → not a candidate; a series already covered by a matching rule
  → excluded; amount drift beyond tolerance → not a candidate. `detectRecurringCadence` unit-tested in isolation.
- **C:** shares sum to 1 within a category (incl. `othersSpent`); `topN` cutoff + remainder correct;
  per-currency; single-merchant category → 100%; effective-only.
- **D:** an over-budget-trending category → `unrealistic` + `suggestedLimit` ≈ baseline; a well-under budget →
  `generous`; a category with spend and no budget → `unbudgeted` suggestion; per-currency (a BRL budget compared
  only to BRL spend); a budget whose category has no spend → `current: 0`, verdict handles it.

## Implementation prompt

Four PRs, one mode each, behind the full gate. **Phase B depends on Feature Design 017** (recurring merchant) —
land 017 first. Suggested order: A → D → C → (017) → B. Read `docs/architecture.md` (ADR-011 safe-SQL / whitelist
pattern, the aggregate query precedent) before the repo query. Each phase adds one `analysis` mode + its result
shape + its query (and, for B, the pure `logic/` cadence function). Feature-sized (new query surface) →
independent verification subagent per diff.

### Phase A — `feat/correlations-spending-shifts` ✅ Done
The `find_correlations` tool skeleton + `analysis` enum + `spending_shifts` mode: the trailing-baseline query,
result shape, tool registration, `docs/mcp-tools.md`, `docs/architecture.md`, PLAN progress.

### Phase B — `feat/correlations-recurring-candidates`
`recurring_candidates` mode: repo per-merchant series query + `logic/`'s pure `detectRecurringCadence`; the
best-effort rule-exclusion; result shaped for `create_recurring`; docs.

### Phase C — `feat/correlations-merchant-concentration`
`merchant_concentration` mode: the per-category top-merchant + cumulative-share query; result shape; docs.

### Phase D — `feat/correlations-budget-fit`
`budget_fit` mode: reuse A's baseline, join budgets (`list`), per-currency verdicts + `suggestedLimit` for
existing budgets and unbudgeted-significant-spend suggestions; result shape; docs. Read-only — no budget writes
here (the AI applies suggestions via `create_budget`/`update_budget`). Depends on Phase A.

### Finish (every push, every phase)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing.
