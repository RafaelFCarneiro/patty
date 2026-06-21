# ADR-010: Credit cards are liability accounts

**Status:** Accepted · **Date:** 2026-06-21 · Builds on ADR-002 (transfers are transactions). Revises invariant
#8 in `docs/architecture.md`. Realized by Feature Design 003 (bill payment).

## Context

A credit-card purchase references `credit_card_id` (+ `bill_id`) but **no account**, so it touches no balance —
it only accrues on the fatura. `pay_bill` flips the bill to `paid` and records nothing else. Two real gaps
follow: (1) the cash that leaves a bank account to pay the bill is never recorded, so the paying account's
balance is permanently overstated; (2) there is no representation of how much you currently owe on a card.

The natural fix is to record the payment as a money movement. A first proposal modeled it as a **one-legged
transfer** (FROM the paying account, no TO) — but that breaks ADR-002's canonical "a transfer moves value
between two accounts." The cleaner fix is to give the card the missing counterparty: **its own account.** Then a
purchase is debt against that account and a payment is an ordinary two-legged transfer that pays the debt down —
ADR-002 stays intact and the card gains a meaningful balance (outstanding debt / utilization).

## Decision

A **credit card is backed by a 1:1 internal liability account.**

1. **New account type `credit`.** `AccountType` gains `credit` alongside `checking | savings | wallet |
   investment`.
2. **Each card owns an internal account.** Creating a credit card auto-creates a `credit` account in the card's
   currency (initial balance 0); `credit_cards.account_id` links them 1:1. The card's outstanding debt is that
   account's (negative) balance — no new balance field, just the existing derivation. A `credit` account exists
   **only** as a card's counterpart: `create_account` rejects `type: 'credit'` (a `validation` error) — there is
   no standalone credit account, and a card always has exactly one — created with the card and deleted with it
   (Feature Design 003's `delete_credit_card`).
3. **Card purchases post to the card account.** A card purchase sets `from_account_id` = the card's internal
   account (in addition to `credit_card_id` for the fatura). It stays an `expense` (so categorized spend is
   unchanged), but it is now *funded by* the card account, driving its balance negative = debt. Balance and
   summary SQL are reused unchanged: `balanceParts` already derives any account's balance from its transactions;
   `summaryRows` still counts the expense once.
4. **Bill payment is a canonical transfer (ADR-002 preserved).** Paying a bill is a `type: 'transfer'` with both
   legs: FROM a bank account, TO the card's internal account. It debits cash and credits the card account toward
   zero, and is excluded from spending summaries (no double-count). `pay_bill` creates it and marks the bill
   `paid` (Feature Design 003).
5. **`pay_bill` is the only sanctioned way value enters a card account.** Raw `create_transfer` with a `credit`
   account on either leg is disallowed (a `validation` error) — it would pay down debt without settling a bill,
   or model a cash advance, both out of scope. Card debt changes only via purchases (accrue) and bill payments
   (settle).
6. **Card accounts are visible.** `get_account_balances` / `list_accounts` include `credit` accounts; a negative
   balance is outstanding debt, which nets correctly against cash for net worth.

## Options Considered

### Option A — One-legged "outbound" transfer (FROM only, no TO)
**Pros:** minimal; no card account; purchases unchanged.
**Cons:** breaks ADR-002 (transfers must have both legs); the card never gains a balance; summary/balance code
has to tolerate a half-populated transfer. Rejected.

### Option B — Keep purchases as-is; derive the card balance specially
**Pros:** purchase recording untouched.
**Cons:** forks the balance computation — a dedicated path for `credit` accounts (`−Σ` card expenses by
`credit_card_id` + payments) parallel to the normal derivation. More code paths, less uniform. Rejected.

### Option C — Card is a liability account; purchases post to it — **chosen**
| Dimension | Assessment |
|---|---|
| Correctness | Full double-entry; card balance = real outstanding debt |
| ADR-002 | Preserved (payment is a normal two-legged transfer) |
| Uniformity | Reuses `balanceParts`/`summaryRows` unchanged |
| Cost | Changes how card purchases are recorded (the main ripple) |

**Pros:** correct and uniform; ADR-002 intact; the card balance becomes genuinely useful.
**Cons:** card purchases now carry an account leg — downstream must not assume "card purchase ⇒ no
`from_account_id`"; existing dev data needs a reset (clean slate).

## Trade-off Analysis

The decision is **canonical model vs. minimal change.** Option A is least code but violates an accepted ADR and
yields no card balance. Option C costs a change to purchase recording but buys correctness, a useful card
balance, and — crucially — keeps the transfer primitive canonical, so nothing else in the money model bends.
That's worth the ripple, especially while there's no production data to migrate.

## Consequences

- **Schema:** `accounts.type` gains `credit`; `credit_cards` gains `account_id` (FK → the internal account) and
  `payment_account_id` (FK → the default paying bank account, Design 003). Migration generated; existing dev DB
  reset (clean slate — no production data).
- **Card creation** auto-creates the internal `credit` account (card currency, balance 0) and links it.
- **Card purchases** set `from_account_id` = the card account. Audit anything that assumed card purchases have no
  account leg (adapters, balance/summary, extrato) — the queries themselves are unchanged and correct.
- **Invariant #8 revised:** *"Card purchases are funded by the card's internal liability account (debt). Bill
  payment is a canonical transfer (ADR-002) from a bank account to the card account, excluded from spending
  summaries — never an expense (double-count). `pay_bill` creates it and marks the bill paid. Value enters a
  `credit` account only via `pay_bill`."*
- **Visibility:** `credit` accounts appear in balances (negative = owed) and `list_accounts`.
- **Restriction:** `create_transfer` rejects `credit` accounts on either leg.
- **Realized by Feature Design 003**, which owns `pay_bill`, the `payment_account_id` default, currency
  validation, and idempotency.

## Action Items

1. [ ] `AccountType` + `credit`; `credit_cards.account_id` + `payment_account_id`; migration.
2. [ ] Auto-create + link the internal account on card creation; `create_account` rejects `type: 'credit'`.
3. [ ] Card purchases set `from_account_id` = the card account; audit downstream assumptions.
4. [ ] Disallow `create_transfer` touching a `credit` account.
5. [ ] Revise invariant #8 and the schema section in `docs/architecture.md`; index this ADR.
