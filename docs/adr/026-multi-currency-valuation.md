# ADR-026: Multi-currency valuation — crypto currencies, an agent-refreshed rate table, read-time conversion to a base currency

**Status:** Proposed · **Date:** 2026-07-26 · **Deciders:** Rafael · Resolves the long-standing cross-currency
open question (PLAN). Relaxes the **no-implicit-conversion** invariant (Feature Design 001 family) in a bounded
way, and formalizes the **local-first, zero-external-call** posture (ADR-004/005) for rate data. Extends the
currency model seeded in the beginning (BRL/USD).

## Context

FinTrack stores each amount in the transaction's own currency and **never converts** — every total
(`get_spending_summary`, `get_budget_status`, all `find_correlations` modes) is grouped per currency. That is a
deliberate invariant: without a rate source, any cross-currency sum is arbitrary.

The user holds value across **fiat and crypto** — BRL, USD, plus USDC and BTC — and wants a consolidated view in
a home currency, most concretely: *when I read an account's value and its currency isn't my home currency, show
me the converted amount too*, and a net-worth total across all of them.

Grounded constraints this must respect:

- **Amounts are stored as float** (`amount real`; `Money = z.number().positive()`). Fine for fiat; imprecise for
  BTC's 8 decimals.
- **`CurrencyCode` is a zod enum** seeded BRL/USD; crypto codes (USDC, BTC) are **not** ISO 4217, so
  `Intl.NumberFormat`'s currency mode can't format them — display needs per-currency symbol + decimals.
- **`settings` has only `locale`** (language en/es/pt) — no notion of a display/home currency. Locale ≠ currency.
- **The backend makes zero external HTTP calls** (local-first, zero-infra — ADR-004/005). Fetching FX/crypto
  rates would be the first such dependency.

## Decision

Add crypto currencies as first-class, an **agent-refreshed cached rate table**, a **base currency** setting, and
a **read-time valuation** layer — while keeping per-currency spend the source of truth and the backend free of
external calls.

### 1. Currencies extend to fiat + crypto

Add **USDC** and **BTC** to the `CurrencyCode` enum and the `currencies` seed. Add a **`decimals`** column to
`currencies` (fiat 2, USDC 6, BTC 8) so amounts format correctly; display uses the currency's `symbol` +
`decimals` (a crypto-aware path in `formatMoney`, since `Intl.NumberFormat` currency mode rejects non-ISO codes).
This alone lets the user *hold* USDC/BTC accounts and record transactions in them — independent of any
conversion.

### 2. Amounts stay float — risk documented, escape hatch named

No storage change (`amount real`). Float is imprecise for BTC's 8 decimals; accepted at personal scale, and
**valuation is inherently approximate anyway** (it depends on a fluctuating rate), so float on the *converted*
side is a non-issue. The documented risk is summation of many small native BTC amounts. The escape hatch, if it
ever bites: store amounts as **integer minor-units** (cents, satoshis) — a cross-cutting change deferred until
warranted, recorded here so it isn't re-litigated.

### 3. A cached `currency_rates` table, agent-refreshed — the backend never fetches

New table: **`currency_rates(from_code, to_code, rate, as_of, source?)`**, meaning *1 unit of `from` = `rate`
units of `to` as of `as_of`*. The **agent (or a scheduled task) upserts** rows — it has web access and can pull
PTAX (fiat) and a crypto price source; the **backend makes no external call** (local-first preserved). Tools:
a write `set_exchange_rate(s)` (upsert) and a read `list_exchange_rates`. Rates are self-contained and carry
`as_of`, so freshness is visible.

- **Staleness is surfaced, never hidden.** Every conversion returns the rate's `as_of` and a `stale` flag (older
  than a configurable threshold); a **missing** rate yields the per-currency value plus a `no_rate` marker —
  the system never fabricates a number.

### 4. Base currency in `settings`

Add **`base_currency`** (FK `currencies.code`), defaulted from locale (pt→BRL, en→USD, es→USD) but explicitly
settable (a `set_base_currency` tool, or fold into preferences). It's the default target for valuation.

### 5. Conversion is read-time valuation only — spend stays native

Transactions keep their native-currency amounts unchanged; the per-currency invariant holds for **spend**. A
**read-time** conversion layer values holdings against the latest `currency_rates`:

- **`get_account_balances`** — for an account whose currency ≠ `base_currency`, include the converted value (with
  `as_of`/`stale`), and a **consolidated net total** in the base currency across all accounts (accounts with a
  missing rate are listed but excluded from the total, flagged).
- **Opt-in elsewhere** — a `displayCurrency`/convert flag can later add a converted grand-total on top of
  budgets' and `find_correlations`' per-currency lines. Scoped as a follow-on; the core is account valuation.

**The invariant, restated:** *no implicit conversion of spend; valuation conversion is explicit, rate-sourced,
read-time, and always stamped with its `as_of`.* Per-currency remains the default and the source of truth.

## Options Considered

- **Rate source — cached agent-refreshed table (chosen)** vs agent-provides-per-call vs backend-fetch. Backend-
  fetch (PTAX + a crypto API) was rejected: it breaks the zero-external-call posture (network, caching, offline
  fallback). The cached table keeps the backend pure, stores rates self-contained + historical, and fits the
  local-first identity (like `apply_due_recurring`, refresh is a scheduled/agent op). Agent-per-call keeps
  nothing server-side.
- **Amount precision — float, documented (chosen)** vs integer minor-units — the latter is correct but a
  cross-cutting change to *all* amounts; deferred behind the named escape hatch.
- **Conversion timing — read-time valuation (chosen)** vs write-time rate on each transaction — write-time is
  heavier and, for "what's it worth now" (crypto especially), you need current rates anyway; spend accounting
  needs no conversion.
- **Rate table shape — explicit `(from,to)` pairs (chosen)** vs a single-pivot (each currency→USD, derive cross
  rates). Pairs are simpler to reason about and the agent only needs to populate the pairs actually used
  (held currency → base); a pivot optimization can come later if the pair count grows.

## Consequences

- **The no-implicit-conversion invariant is relaxed, precisely** — spend stays per-currency; valuation is an
  explicit, `as_of`-stamped, read-time layer. `docs/architecture.md`'s currency invariants gain this wording.
- **Backend stays local-first** — no external calls; rate freshness is the agent's/scheduler's responsibility,
  and staleness/missing rates degrade gracefully (flagged, never fabricated).
- **Float precision risk** is documented with the integer-minor-units escape hatch.
- **New `currency_rates` entity** (FC/IS write flow + applier, like any table), `set/list_exchange_rates` tools,
  `settings.base_currency`, crypto-aware `formatMoney`, and converted fields on `get_account_balances`.
- **Migrations:** `CurrencyCode` += USDC/BTC and seed; `currencies.decimals`; `currency_rates` table;
  `settings.base_currency`.
- **New external-data trust boundary** — rates are user/agent-supplied; they are decoded at the boundary (zod)
  like any input and are never treated as authoritative beyond their `as_of`.

## Migration plan (phased — behind the full gate)

1. **Crypto currencies first-class** (`feat/crypto-currencies`): `CurrencyCode` += USDC/BTC + seed;
   `currencies.decimals`; crypto-aware money formatting (`formatMoney` + the dashboard). No conversion yet — the
   user can hold and transact in USDC/BTC. Purely additive.
2. **Rates + base currency** (`feat/currency-rates`): the `currency_rates` table + entity + `set/list_exchange_rates`
   tools (agent-refreshed); `settings.base_currency` + its setter; the read-time conversion helper in `logic/`
   (pure: amount × rate, with `as_of`/`stale`/`no_rate` outcomes) — no consumer yet.
3. **Account valuation** (`feat/account-valuation`): `get_account_balances` gains per-account converted values +
   the consolidated base-currency net total (stale/missing flagged). Optionally, the opt-in `displayCurrency`
   grand-totals on summaries/budgets/`find_correlations` as a follow-on.

## Action Items

1. [ ] Review/accept this ADR.
2. [ ] Phase 1 — crypto currencies (enum + seed + `decimals` + formatting).
3. [ ] Phase 2 — `currency_rates` entity + `set/list_exchange_rates` + `settings.base_currency` + the pure
   conversion helper.
4. [ ] Phase 3 — `get_account_balances` valuation (converted values + net total, staleness-flagged).
5. [ ] Record the relaxed valuation invariant + the local-first "rates are agent-refreshed, backend never
   fetches" note in `docs/architecture.md`; PLAN open-question → resolved.

Each phase touches the schema and/or a new write flow → feature-sized → independent verification subagent per
diff.
