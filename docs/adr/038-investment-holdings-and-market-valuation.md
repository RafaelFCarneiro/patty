# ADR-038: Investment holdings and market valuation

**Status:** Accepted · **Date:** 2026-11-17 (accepted 2026-11-18) · **Deciders:** Rafael · **Extends ADR-026** (agent-sourced external data,
read-time valuation) from currencies to assets. Keeps ADR-002 (transfers are one row, same currency), ADR-028
(read-side correlation in controllers) and ADR-029 (domain-derived idempotency).

## Context

Investment accounts ("Nu Holdings (NYSE:NU)", "Nubank FII", "Itaú TD / Selic") are plain accounts with a static
balance. A position's value is **quantity × market price × FX rate**, but PATTY only knows the balance, so market
moves are posted as fake "Rendimentos" income or expense. That inflates the cash-flow reports with unrealized gains
and loses what matters: how many units are held, what was paid, and what they are worth now.

What exists and is reused:

- **ADR-026:** `currency_rates` is agent-refreshed (the backend never fetches), valuation happens at read time
  (`logic/currency-rate.ts`: `convert`, `consolidateNetWorth`), every converted figure carries `asOf`/`stale`, and a
  missing rate is reported, never fabricated. `user_settings.base_currency` is the valuation target.
- **Summaries read only `transactions`** and exclude `type: 'transfer'`; balances are derived
  (`initialBalance + income − expenses ± transfers`), never stored.
- **`CurrencyCode` is a fixed enum** (BRL, USD, MXN, COP, USDC, BTC). BTC and USDC are already currencies: a BTC wallet
  is an account in BTC, valued through `currency_rates`.

## Decision

### 1. Three new concepts, and what stays as it is

- **Asset:** something with a price. `symbol` (e.g. `NU`, `KNCR11`, `TESOURO-SELIC-2031`), `exchange` (e.g. `NYSE`,
  `B3`; unique with the symbol), `name`, `assetClass` (`stock`, `etf`, `reit` (FII), `bdr`, `fixed_income`),
  `currency` (the quote currency, a `CurrencyCode`), and `pricing`: `market` (a public quote exists) or `manual` (the
  agent posts the value, e.g. a CDB).
- **Price:** `asset_prices(asset_id, price, as_of, source)`, the price of **one unit** in the asset's currency,
  agent-supplied exactly like rates. Unlike `currency_rates` it keeps **history** (unique per asset and `as_of`; the
  latest is the newest `as_of`), because period performance needs a price at the start of the period (§7).
- **Investment event:** what changes a position, owned by a user and an account: `opening`, `buy`, `sell`, `split`.
  Dividends are not events: they are income transactions (§3).
- **Crypto stays a currency.** A BTC or USDC wallet keeps working as an account in that currency, valued by
  `currency_rates`. No `crypto` asset class: two ways to hold BTC would value it twice.

Assets and prices are **shared reference data**, like currencies and rates: one `NU@NYSE` and one price series for
the instance, readable by every user, and `asset_price` joins `SHARED_ENTITY_TAGS`. Events are **owned** (`user_id NOT
NULL`, scoped repo and applier, a row in the tenancy isolation suite).

### 2. Positions are derived from events, never stored

A position (account × asset) is a **pure fold of its events in date order** (`logic/`), with the **average-cost**
method:

| Event | Quantity | Average cost (asset currency) | Realized P&L |
|---|---|---|---|
| `opening` (qty, avgCost) | set | set | — |
| `buy` (qty, price, fees) | + qty | (q·avg + qty·price + fees) / (q + qty) | — |
| `sell` (qty, price, fees) | − qty | unchanged | qty·price − fees − qty·avg |
| `split` (ratio n:m) | × n/m | × m/n | — (value unchanged) |

Bonus shares (*bonificação*) are a `buy` with price 0 or the declared cost. Like balances, positions are never
stored, so editing or deleting a past event recomputes everything after it. A write that would make any point of the
timeline negative (selling more than held, at that date) is refused with the date and the shortfall. Quantities
are `real` like amounts (ADR-026 §2; fractional shares allowed).

### 3. Money movements keep cash flow clean by construction

- **Buy / sell** carry a **cash leg** on a cash account (`cashAccountId`; it may be the investment account itself,
  which then holds broker cash): a buy takes `qty·price + fees` out, a sell puts `qty·price − fees` in. The cash leg
  lives on the event, **not** in `transactions`, so no summary, budget or correlation can ever count it, the same way
  transfers are excluded today. The balance rule gains one term: `… ± transfers − buy legs + sell legs`. The cash
  account's currency must equal the asset's (cross-currency trades wait for FX conversion, like ADR-002 transfers).
- **Dividends / distributions** (KNCR11's monthly yield, stock dividends) are **real income**: an `income`
  transaction on the cash account, with a new nullable `transactions.asset_id`, category "Investments" by default.
  They count in cash flow, and yield per asset comes from that link.
- **Price changes never create transactions.** Mark-to-market exists only at read time.

### 4. Valuation at read time (ADR-026 extended)

Per position: `marketValue = qty × latestPrice` (asset currency), converted to the base currency with `convert`;
`costBasis = qty × avgCost`; `unrealized = marketValue − costBasis`, both in asset and base currency. Every valued
figure carries `asOf` and `stale`; prices use their own threshold `PRICE_STALE_HOURS` (default 72 h, so a Friday close
is still fresh on Monday) and `MANUAL_PRICE_STALE_DAYS` for manual assets (default 31). **A missing price never
becomes zero:** the position is listed with quantity and cost and `value: null, noPrice: true`, and is excluded from
totals with the exclusion listed, as `consolidateNetWorth` already does for a missing rate.

Correlating events, prices, rates and balances crosses aggregates, so it is **controller-orchestrated** (ADR-028):
each repo reads only its table, and pure `logic/` folds, values and consolidates.

### 5. Manually valued assets use the same machinery

A CDB or a pension fund is an asset with `pricing: manual`, usually held as quantity 1 at the invested amount
(`opening` or `buy`). The agent posts its current value with the same price tool. A contribution is a `buy`, a
redemption a `sell` (realized P&L included). A valuation update is a price, so it is never cash income. Treasuries
(Tesouro Selic, IPCA+) can be `market` with their unit price (PU) when the agent can source it.

### 6. Reports, separated

- **Cash flow** (`get_spending_summary`, budgets, correlations): unchanged code, and by §3 only real money: dividends
  are income; trades are invisible; prices never appear.
- **Net worth** (`get_account_balances`): every account's cash balance (the new balance rule) **plus** holdings
  market value, all in the base currency. An investment account reports `cashBalance`, `holdingsValue` and `total`.
- **Investment performance** (new): per position and per account, for a period: invested (cost basis), current
  value, unrealized P&L, realized P&L in the period, dividends in the period, and allocation % by asset class and by
  currency.

### 7. Moving existing accounts

`open_position` converts an account: the agent gives asset and quantity (and average cost, defaulting to the current
price when unknown, with a warning that P&L starts from there). `remainingCash` (default 0) is the account's cash
balance **after** the conversion: the account's `initialBalance` is set to `remainingCash` minus the net movement of
the transactions the account already has (income − expenses ± transfers), **in the same batch**, so the computed
balance equals `remainingCash` and the old static value and the new holdings are never counted together. Existing
activity is offset, not erased: the response reports it (`existingActivity`) and warns, because entries that only
recorded market moves are not money and should be deleted before converting, or they stay in cash-flow reports.
The remembered cash (below) is the previous `initialBalance`, so deleting the last event restores the account exactly.
Accounts that are not converted keep today's balance-only behavior.

The conversion is **reversible**, and its state belongs to the **account**, not to any one opening: `accounts.cash_before_holdings` remembers the `initialBalance` the account held before it held positions (null when none was remembered). `open_position` always writes the account (an update, so its version moves even when the cash stays) and, when `cash_before_holdings` is null and the opening changes `initialBalance`, remembers the balance it is replacing; later openings keep what is remembered. Deleting an opening is allowed in any order and always writes the account too; only when the deleted event is the account's **last** investment event does `initialBalance` become `cash_before_holdings` (if not null), which is then cleared, in the same batch — the response says so with `restoredCash`. Because every opening and every deletion updates the same account version, a concurrent sibling opening and a deletion conflict and retry, so the remembered cash can never be given back while a position it stood for is still held. Deleting the last event does overwrite a later edit of `initialBalance` with the remembered value — the agent adjusts it afterwards with `update_account` if needed. Deleting any other event type never touches the account. (An earlier cut stored `replaced_cash` per opening and refused deleting an opening that had replaced cash while others remained; it could deadlock two openings that both changed the cash, and it left a race with a concurrent sibling, so the state moved to the account.) The account's `type` and `currency` are pinned while it has investment events, since the remembered cash and the holdings are tied to them. **One opening per position is enforced by the database**, not only by the flow's pre-check: a partial unique index on `(user_id, account_id, asset_id) WHERE type = 'opening'`; a concurrent second `open_position` that loses the race is retried by the engine (`VersionConflict`) and re-reads the winner's opening: an identical request is answered as the same opening (`created: false`), a different one gets the ordinary "already has an opening" validation error, never a 500.

## MCP surface

New tools (each a `defineTool` in a new `diplomat/mcp/tools/investment.ts`, documented in `docs/mcp-tools.md`):

| Tool | Kind | Input → output |
|---|---|---|
| `register_asset` | write | symbol, exchange, name, assetClass, currency, pricing → the asset (idempotent on symbol+exchange) |
| `list_assets` | read | filter by class / `staleOnly` → assets with latest price, `asOf`, `stale` |
| `set_asset_prices` | write | `[{ asset, price, asOf, source? }]` → per-item result (bulk, like `set_exchange_rates`) |
| `open_position` | write | account, asset, quantity, avgCost?, date?, `remainingCash?` → the position (§7) |
| `buy_asset` / `sell_asset` | write | account, asset, quantity, price, fees?, date, cashAccount?, discriminator? → position + realized P&L |
| `record_split` | write | account, asset, ratio, date → position |
| `record_dividend` | write | cashAccount, asset, amount, date, description? → the income transaction |
| `list_investment_events` | read | account?/asset?/period → events |
| `update_investment_event` / `delete_investment_event` | write | id (+ fields) → recomputed position, refused if the timeline goes negative |
| `get_portfolio` | read | account? → positions with quantity, avg cost, price, value, unrealized P&L, `asOf`/`stale`/`noPrice`, allocation |
| `get_investment_performance` | read | period, account? → §6 performance |
| `reconcile_holdings` | read (dry run) | `[{ asset, quantity, value? }]` from a screenshot → matches, differences, unknown assets and **proposed** operations; never writes |

Changed: `get_account_balances` (cash/holdings split, holdings in net worth) and the balance rule (trade cash legs).
New resource: `patty://assets`, next to `patty://currencies`. A guided prompt (Design 019 style) `refresh_quotes` drives
"atualizar câmbio/cotações": list stale prices and pairs, source them, upsert, read the portfolio again, and report the
change split into price effect `qty·(p₁−p₀)·fx₀` and FX effect `qty·p₁·(fx₁−fx₀)`, from the values before and after.

Idempotency follows ADR-029: an event's key is derived from account, asset, type, date, quantity, price and the
optional `discriminator`; a dividend is a transaction and uses the existing derivation.

## Edge cases

- **Partial sell:** average cost unchanged; realized P&L only on the units sold.
- **Selling more than held, or an edit that makes an earlier point negative:** refused with date and shortfall.
- **Missing price:** listed with quantity and cost, `value: null`, excluded from totals and named as excluded.
- **Stale price or rate:** valued, flagged; totals say `stale: true` if any part is.
- **Multi-currency:** each position is valued in its asset currency, then converted; a missing FX pair excludes it
  from base totals like a missing price (`noRate`).
- **Splits after buys:** the fold applies them in date order; the same date sorts splits before trades.
- **An asset whose quote currency is not in `CurrencyCode`** (e.g. EUR): cannot be registered until the currency is
  added (a seed migration, as MXN/COP were).
- **Deleting an account with events:** refused, like an account with transactions.

## Options considered

- **Stored positions updated by each event** (rejected): faster reads, but an edited or deleted past event would need
  every later position rewritten, and the stored state can drift. The fold is pure, testable and small at personal
  scale; balances already work this way.
- **Trades as `transfer` transactions** (rejected): a buy is not a movement between two accounts' cash, and recording
  it as a transaction would put investment detail into the cash-flow tables that every summary reads.
- **Price adjustments as income/expense** (today's workaround, rejected): the problem this ADR exists to remove.
- **Crypto as an asset class** (rejected): BTC/USDC are already currencies with rates; two models would double-count.
- **Latest-only prices like `currency_rates`** (rejected for prices): period performance needs the price at the start
  of the period. Rate history stays out of scope here (see Consequences).

## Consequences

- Cash flow stays truthful by construction, and net worth gains real positions.
- New tables: `assets`, `asset_prices` (shared), `investment_events` (owned); `transactions.asset_id`. The balance
  rule gains the trade cash legs, documented in `docs/architecture.md`.
- New configuration: `PRICE_STALE_HOURS`, `MANUAL_PRICE_STALE_DAYS`.
- Base-currency period performance uses today's rate for both ends of the period until rate history exists; the
  report says so (`fxBasis: "current"`). Exact FX attribution over time is a later ADR.
- Out of scope, not blocked: taxes (Brazilian capital gains, exemptions, DARF), options and derivatives, broker
  integrations, intraday prices, cross-currency trades.

## Plan

1. [x] **MVP — holdings, prices, valuation, net worth** (`feat/investment-holdings`, #281): `assets`, `asset_prices`,
       `investment_events` with `opening` only; `register_asset`, `list_assets`, `set_asset_prices`,
       `open_position` (with the §7 conversion), `list_investment_events`, `update/delete_investment_event`,
       `get_portfolio`; `get_account_balances` includes holdings; manual assets; the `refresh_quotes` prompt.
2. [ ] **Trades and income** (`feat/investment-events`): `buy`/`sell`/`split` with cash legs and the balance rule,
       `record_dividend` (`transactions.asset_id`), realized P&L. Every investment event deletion updates the account;
       the account's last event, whatever its type, restores `cash_before_holdings`.
3. [ ] **Performance and reconciliation** (`feat/investment-performance`): `get_investment_performance`,
       `reconcile_holdings`, an investments dashboard.
