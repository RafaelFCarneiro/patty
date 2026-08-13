# Feature Design 021: `displayCurrency` — opt-in converted grand totals on per-currency reads

**Type:** Feature design (a capability + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress (Phase 1 done) · **Date:** 2026-08-10 · This design implements the
follow-on ADR-026 scoped ("an opt-in `displayCurrency`/convert flag can later add a converted grand-total on
top of budgets' and `find_correlations`' per-currency lines"). Governed by **ADR-028** (the conversion
correlates two aggregates, so it is controller-orchestrated — no repo joins `currency_rates`). Reuses the
phase-3 conversion logic (`logic/currencyRate.ts`).

> **Implementation status**: `Not started` · `In progress` · `Done` · `Blocked`. Phased (see Migration plan);
> one branch per phase.

## Context

ADR-026 delivered read-time valuation on **`get_account_balances`** (per-account converted values + a
consolidated net-worth total in the base currency, staleness-flagged, no-rate excluded). The other read surfaces
that group **per currency** — `get_spending_summary`, `get_budget_status`, `find_correlations` — still return
only per-currency lines with **no cross-currency total**: "how much did I spend in total this month across BRL +
USD + BTC?" can't be answered in one number. That's the deliberate no-implicit-conversion-of-spend invariant,
but the user now has a rate source, so a **converted total should be available on demand** here too, exactly as
it already is for balances.

## Decision

Add an **opt-in `displayCurrency?: CurrencyCode`** parameter to the per-currency read tools. When provided, the
response gains a **converted grand total** in that currency, computed read-time against `currency_rates` and
`as_of`-stamped; when omitted, behavior is **unchanged** (per-currency lines only). Per-currency lines stay the
**source of truth** — conversion is purely additive on top.

- **Surfaces:** `get_spending_summary`, `get_budget_status`, `find_correlations` (the ADR's named three).
  `aggregate_spending` is an optional extension (same mechanism) — deferred unless wanted.
- **Explicit target, not magic.** `displayCurrency` is an explicit `CurrencyCode`. A caller wanting "my home
  currency" passes their `base_currency` (readable via `get_preferences`) — the tools stay stateless and
  unambiguous, and `displayCurrency` can differ from the stored base when a caller wants a one-off view.
- **Additive response shape.** A top-level `converted` block:
  `{ displayCurrency, total, stale, asOf, excluded: [{ currency, reason: 'no_rate' }] }`. Per-currency lines are
  untouched. A currency with no rate to `displayCurrency` is **listed in `excluded` and left out of the total**
  (never fabricated) — the exact `consolidateNetWorth` contract, generalized. `stale`/`asOf` reflect the rates
  used (a total is `stale` if any contributing rate is stale; per-class thresholds from ADR-026: fiat 24h,
  crypto 1h).
- **Per-line converted values** (secondary): each per-currency line *may* also carry its own `converted` value,
  same shape as balances. Cheap and consistent, but the grand total is the primary deliverable — include per-line
  only where a surface's shape makes it natural.

### Where each concern lives (ADR-028)

- **Repos** stay per-aggregate: the summary/budget/correlations repos return their own per-currency reads
  (unchanged); `currencyRatesRepo` returns rates. **No repo joins `currency_rates`.**
- **Controller** orchestrates: fetches the per-currency read + the rates + resolves `displayCurrency` +
  the per-class staleness thresholds (config → controller, never logic), and calls the pure helper.
- **Logic:** generalize `consolidateNetWorth` (`logic/currencyRate.ts`, today typed to
  `{ id; converted? }` account balances) into a reusable **`consolidateInCurrency(amountsByCurrency, target,
  rates, now, thresholds, targetDecimals)`** that converts a set of per-currency amounts, sums the convertible
  ones, and returns `{ total, stale, asOf, excluded }`. `get_account_balances` keeps its own thin wrapper; the
  three new consumers share the generalized helper. The rule ("convert per-currency amounts to a display
  currency, stamp staleness, exclude no-rate") gets **one home**, mirroring the single-source instinct behind
  `txPredicates`.

## Options considered

- **Opt-in explicit `displayCurrency` (chosen)** vs always-convert-to-base. Always-convert would change every
  existing response contract and demote per-currency (the source of truth) — ADR-026 explicitly scoped this as
  opt-in. Explicit param keeps the default behavior byte-identical.
- **Explicit target (chosen)** vs auto-default to `base_currency` when a `convert: true` flag is passed. Explicit
  is stateless and unambiguous and lets a caller convert to something other than their stored base; the client
  passes `base_currency` when it wants the home total. (Revisit if the agent ergonomics argue for a `convert`
  boolean that defaults the target to base.)
- **Grand total primary, per-line optional (chosen)** vs per-line-only vs grand-total-only. The grand total is
  the missing capability; per-line converted values are a cheap consistency nicety, added where natural.
- **Generalize `consolidateNetWorth` (chosen)** vs a second bespoke consolidation per surface — one home for the
  conversion+exclusion rule, no drift.

## Migration plan (phased — one branch each, behind the full gate)

1. **Helper + `get_spending_summary`** (`feat/display-currency-summary`, **done**): generalized
   `consolidateNetWorth` → `consolidateInCurrency` (`logic/currencyRate.ts`, both now share a private `consolidate`
   core); added `displayCurrency?` to `get_spending_summary` (MCP + `GET /api/summary`); controller-orchestrated
   conversion of the summary's per-currency `expenses` into the top-level `converted` block — the exemplar.
2. **`get_budget_status`** (`feat/display-currency-budgets`): `displayCurrency?` on the tool + `GET /api/budgets/status`;
   converted total across the per-currency/per-category lines.
3. **`find_correlations`** (`feat/display-currency-correlations`): `displayCurrency?` on the tool (MCP-only —
   `find_correlations` has no REST mirror); converted totals where a mode reports per-currency money
   (`spending_shifts`, `budget_fit`, `merchant_concentration`).
4. **(Optional) `aggregate_spending`** — same param + helper, if wanted.

Optionally, the overview/budget dashboards can surface the converted grand total (using `window.formatMoney` in
the display currency) — a UI follow-on, not required by the tools.

## Testing

- **Logic (`test/unit/logic/currencyRate.test.ts`):** `consolidateInCurrency` — mixed fiat+crypto convert and
  sum to target decimals; a missing pair is excluded (not fabricated) and listed; `stale` true iff any
  contributing rate is stale (per-class boundary); target==source is identity. Reuse/extend the existing
  `consolidateNetWorth` tests.
- **Integration (per surface):** `displayCurrency` omitted → response byte-identical to today (regression pin);
  provided → correct converted total, exclusions, staleness; per-currency lines unchanged either way.
- Success **and** expected-failure (unknown `displayCurrency` → validation error).

## Docs to update (per phase)

- `docs/mcp-tools.md` — the new `displayCurrency` arg + `converted` response block on each tool.
- `docs/architecture.md` — extend the ADR-026 valuation note: converted grand totals are available opt-in on
  the per-currency reads too, controller-orchestrated, spend still per-currency by default.
- ADR-026 — tick the "opt-in `displayCurrency` grand-totals" follow-on as this design lands.
