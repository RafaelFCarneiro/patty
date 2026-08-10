# ADR-026: Multi-currency valuation — crypto currencies, an agent-refreshed rate table, read-time conversion to a base currency

**Status:** Accepted · **Date:** 2026-07-26 (refreshed + accepted 2026-08-09) · **Deciders:** Rafael · Resolves the
long-standing cross-currency open question (PLAN). Relaxes the **no-implicit-conversion** invariant (Feature
Design 001 family) in a bounded way, and formalizes the **local-first, zero-external-call** posture (ADR-004/005)
for rate data. Extends the currency model seeded in the beginning (BRL/USD).

> **Drafted before ADR-027/028 and the `txPredicates` work; reconciled with them here.** The one material
> interaction: **phase 3's account valuation is a read-side correlation across two aggregates (`accounts` ×
> `currency_rates`), so under ADR-028 it lives in the controller, never a fused repo join** — the accounts
> repo returns balances, the rates repo returns rates, the controller correlates, and the pure conversion helper
> in `logic/` values them. This fits the ADR's own "conversion helper in `logic/`" decision; it just makes the
> boundary explicit. See § 5 and the migration plan.

## Context

FinTrack stores each amount in the transaction's own currency and **never converts** — every total
(`get_spending_summary`, `get_budget_status`, all `find_correlations` modes) is grouped per currency. That is a
deliberate invariant: without a rate source, any cross-currency sum is arbitrary.

The user holds value across **fiat and crypto** — BRL, USD, plus USDC and BTC — and wants a consolidated view in
a home currency, most concretely: *when I read an account's value and its currency isn't my home currency, show
me the converted amount too*, and a net-worth total across all of them.

Grounded constraints this must respect (verified against current `main`):

- **Amounts are stored as float** (`amount real`; `Money = z.number().positive()`). Fine for fiat; imprecise for
  BTC's 8 decimals.
- **`CurrencyCode` is a zod enum**, pre-Phase-1 seeded **BRL/USD only** (`src/models/money.ts`); crypto codes
  (USDC, BTC) are **not** ISO 4217, so `Intl.NumberFormat`'s currency mode can't format them correctly — not
  uniformly by throwing, though: a 4-letter code like `USDC` fails `Intl`'s currency-code syntax check and
  throws, but a 3-letter code like `BTC` passes that check and is **silently** formatted with fiat-shaped 2
  decimals and no real symbol instead. Either way, display needs per-currency symbol + decimals, detected
  explicitly rather than via throw/no-throw.
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
`decimals` (a crypto-aware path in `formatMoney`) for any code `Intl.NumberFormat`'s currency mode can't handle
correctly — a malformed code (`USDC`) throws, but a well-formed-but-unrecognized one (`BTC`) doesn't throw and
silently mis-formats instead, so detection must be explicit (`Intl.supportedValuesOf('currency')`), not
try/catch. This alone lets the user *hold* USDC/BTC accounts and record transactions in them — independent of
any conversion.

### 2. Amounts stay float — risk documented, escape hatch named

No storage change (`amount real`). Float is imprecise for BTC's 8 decimals; accepted at personal scale, and
**valuation is inherently approximate anyway** (it depends on a fluctuating rate), so float on the *converted*
side is a non-issue. The documented risk is summation of many small native BTC amounts. The escape hatch, if it
ever bites: store amounts as **integer minor-units** (cents, satoshis) — a cross-cutting change deferred until
warranted, recorded here so it isn't re-litigated. (Confirmed with Rafael: keep float for now.)

### 3. A cached `currency_rates` table, agent-refreshed — the backend never fetches

New table: **`currency_rates(from_code, to_code, rate, as_of, source?)`**, meaning *1 unit of `from` = `rate`
units of `to` as of `as_of`*. The **agent (or a scheduled task) upserts** rows — it has web access and can pull
PTAX (fiat) and a crypto price source; the **backend makes no external call** (local-first preserved). Tools:
a write `set_exchange_rate(s)` (upsert) and a read `list_exchange_rates`. Rates are self-contained and carry
`as_of`, so freshness is visible. The write flow is FC/IS like any other (controller returns a `Persistable`,
the shell applies it via a `currencyRateApplier`; ADR-021/022/023).

- **Staleness is surfaced, never hidden.** Every conversion returns the rate's `as_of` and a `stale` flag (older
  than a configurable threshold); a **missing** rate yields the per-currency value plus a `no_rate` marker —
  the system never fabricates a number.

### 4. Base currency in `settings`

Add **`base_currency`** (FK `currencies.code`), defaulted from locale (pt→BRL, en→USD, es→USD) but explicitly
settable (a `set_base_currency` tool, or fold into preferences). It's the default target for valuation.

### 5. Conversion is read-time valuation only — spend stays native (controller-orchestrated per ADR-028)

Transactions keep their native-currency amounts unchanged; the per-currency invariant holds for **spend**. A
**read-time** conversion layer values holdings against the latest `currency_rates`. Because valuation correlates
two aggregates, it follows **ADR-028**: each repo stays per-aggregate and the **controller** correlates.

- **`get_account_balances`** — the `accounts` controller fetches account balances (accounts repo, its own
  aggregate) **and** the relevant rates (`currency_rates` repo, its own aggregate), then hands both to a **pure
  `logic/` conversion helper** (`amount × rate`, emitting `as_of`/`stale`/`no_rate`). The accounts repo never
  joins `currency_rates`. For an account whose currency ≠ `base_currency`, the response includes the converted
  value (with `as_of`/`stale`); a **consolidated net total** in the base currency across all accounts is
  computed in `logic/` (accounts with a missing rate are listed but excluded from the total, flagged).
- **Opt-in elsewhere** — a `displayCurrency`/convert flag can later add a converted grand-total on top of
  budgets' and `find_correlations`' per-currency lines, same controller-orchestrated shape. Scoped as a
  follow-on; the core is account valuation.

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
- **Conversion location — controller-orchestrated (chosen, ADR-028)** vs a repo join of `accounts`×
  `currency_rates`. The repo join is the read-side bounded-context leak ADR-028 forbids; the controller fetches
  both aggregates and `logic/` converts. Also keeps the conversion rule pure and unit-testable.
- **Rate table shape — explicit `(from,to)` pairs (chosen)** vs a single-pivot (each currency→USD, derive cross
  rates). Pairs are simpler to reason about and the agent only needs to populate the pairs actually used
  (held currency → base); a pivot optimization can come later if the pair count grows.

## Consequences

- **The no-implicit-conversion invariant is relaxed, precisely** — spend stays per-currency; valuation is an
  explicit, `as_of`-stamped, read-time layer. `docs/architecture.md`'s currency invariants gain this wording.
- **Backend stays local-first** — no external calls; rate freshness is the agent's/scheduler's responsibility,
  and staleness/missing rates degrade gracefully (flagged, never fabricated).
- **ADR-028 holds on the read side** — no repo joins `currency_rates` to another aggregate; valuation is a
  controller-orchestrated correlation with a pure `logic/` converter.
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
   - **Phase 1b — precision hardening (tracked, non-blocking; not part of the Phase 1 diff):** two gaps found in
     PR #175 review, where a BTC/USDC amount is still flattened to fiat's 2 decimals outside
     `get_spending_summary`/`aggregate_spending`. Neither blocks Phase 2 — both are self-contained fixes to
     Phase 1's own surface, not rate/valuation work, so they stay under Phase 1 rather than folding into Phase 2.
     - [#176](https://github.com/RafaelFCarneiro/fintrack/issues/176): bulk statement import
       (`import_account_statement`/`import_card_statement`) derives its default idempotency key via
       `amount.toFixed(2)` (`logic/transaction.ts#deriveIdempotencyKey`) — two distinct same-day BTC lines can
       collide on a `...-0.00` key and the second is silently dropped as a duplicate.
     - [#177](https://github.com/RafaelFCarneiro/fintrack/issues/177): `find_correlations`'s five shaping
       functions (`logic/correlations.ts`) still round real money amounts via the fixed-2-decimal `roundMoney`
       — a genuine one-satoshi BTC spending shift or recurring candidate rounds to `0`. `decimalsLookup` needs
       threading through here the same way it was threaded through `summary.ts`/`aggregate.ts`.
2. **Rates + base currency** (`feat/currency-rates`): the `currency_rates` table + entity + `set/list_exchange_rates`
   tools (agent-refreshed, FC/IS write flow); `settings.base_currency` + its setter; the read-time conversion
   helper in `logic/` (pure: amount × rate, with `as_of`/`stale`/`no_rate` outcomes) — no consumer yet.
3. **Account valuation** (`feat/account-valuation`): `get_account_balances` gains per-account converted values +
   the consolidated base-currency net total (stale/missing flagged), **controller-orchestrated per ADR-028**
   (accounts repo + rates repo each per-aggregate; `logic/` converts). Optionally, the opt-in `displayCurrency`
   grand-totals on summaries/budgets/`find_correlations` as a follow-on.

## Action Items

1. [x] Review/accept this ADR (accepted 2026-08-09; refreshed onto `main` from the unmerged
   `docs/plan-phase-3-complete` branch).
2. [x] Phase 1 — crypto currencies (enum + seed + `decimals` + formatting; `GET /api/currencies` +
   `fintrack://currencies` expose the metadata; `logic/money.ts`'s `roundToDecimals`/`decimalsLookup`
   make `get_spending_summary`/`aggregate_spending` rounding currency-decimals-aware).
3. [ ] Phase 1b — precision hardening (non-blocking): fix
   [#176](https://github.com/RafaelFCarneiro/fintrack/issues/176) (bulk-import idempotency keys flatten BTC/USDC
   precision) and [#177](https://github.com/RafaelFCarneiro/fintrack/issues/177) (`find_correlations` still
   rounds crypto amounts to fiat's 2 decimals) — see § Migration plan.
4. [ ] Phase 2 — `currency_rates` entity + `set/list_exchange_rates` + `settings.base_currency` + the pure
   conversion helper.
5. [ ] Phase 3 — `get_account_balances` valuation (converted values + net total, staleness-flagged),
   controller-orchestrated per ADR-028.
6. [ ] Record the relaxed valuation invariant + the local-first "rates are agent-refreshed, backend never
   fetches" note in `docs/architecture.md`; PLAN open-question → resolved.

Each phase touches the schema and/or a new write flow → feature-sized → independent verification subagent per
diff.
