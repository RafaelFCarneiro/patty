# Feature Design 025: Partial bill payment

**Type:** Feature design · **Design status:** Accepted · **Implementation status:** Done (merge) ·
**Date:** 2026-11-25 · Revises Feature Design 011 (bill payment lifecycle) and 012 (a paid bill is
composition-immutable); keeps ADR-010 (a bill payment is a canonical transfer into the card's account).

## Context

`pay_bill` is all-or-nothing: it sums the bill, creates **one** transfer for the whole total (key
`billpay-<billId>`), points `bills.payment_transaction_id` at it and flips the bill to `paid`.
`revert_bill_payment` deletes that one transfer and flips the bill back to `closed`.

People pay part of a fatura: a minimum, an amount agreed with the bank, the rest the following week. Today
the agent can only record the full amount or nothing, so the payer's balance and the card's debt drift from
the bank's.

The card's debt is already right for a partial payment: a payment is a transfer into the card's internal
`credit` account, so whatever stays unpaid remains on that account's balance. What is missing is the bill
side: more than one payment per bill, knowing how much is paid and how much remains, and undoing one payment.

## Decision

1. **`pay_bill` takes an optional `amount`** (positive, rounded to the card currency's decimals). Omitted, it
   pays what remains, so a call without `amount` on an unpaid bill behaves exactly as today. An `amount` above
   what remains is refused (`validation`, naming the remaining amount). A `paid` bill is answered unchanged. An
   unpaid bill whose remaining is 0 or less (a non-positive total, or refunds that brought the total down to
   what is paid) is marked `paid` without a new transfer, as a non-positive total is today.

2. **Each call is one payment, and payments are derived, never counted on the bill.** A bill's payments are
   its transfers into the card's account (`type = transfer`, `bill_id` = the bill, `to_account_id` = the
   card's account), which every payment transfer already carries. From them, pure logic computes:
   - `paidAmount`: the sum of the bill's payments;
   - `remaining`: `total − paidAmount`, rounded to the currency's decimals;
   - `payments`: `[{ id, date, amount, account }]`, oldest first.

   `get_bill` and the `pay_bill` / `revert_bill_payment` responses carry all three.

3. **Status.** A bill becomes `paid` when a payment brings `remaining` to 0. Until then it keeps its cycle
   status (`open` or `closed`), and `partiallyPaid` (`paidAmount > 0` and `remaining > 0`) says it is part paid.
   No new status value: `paid` keeps meaning "settled", and every reader of `status` keeps working. A `paid`
   bill always reports `remaining: 0`, whatever its transfers add up to: a bill settled with a non-positive
   total has no payment at all, and older data may hold a `paid` bill whose transfer is gone.

4. **The single-payment link goes away from storage, not from the contract.** `bills.payment_transaction_id`
   is dropped (the payments are read from the transfers). Before dropping it, the migration copies the link
   onto the transfer (`transactions.bill_id` ← the bill, where the transfer it names has none), so no existing
   payment is lost. The bill view keeps `paymentTransactionId` as the id of the latest payment (absent without
   one), so no client breaks; `payments` is the field to read.

5. **The remainder stays as card debt.** Nothing is carried to the next bill. Interest the bank charges on an
   unpaid remainder (rotativo) is recorded by the agent as a card charge on the next bill. The docs say so.

6. **A payment's idempotency key is domain-derived**, like a transaction's: sha256 over
   `joinUnambiguously([bill id, date, amount rounded to the currency's decimals, discriminator?])`, with an
   optional caller `discriminator` for two genuinely distinct identical payments (same bill, day and amount).
   Repeating a call is safe. Existing `billpay-<billId>` keys stay on their rows; they never collide with the
   new form.

7. **Only a fully paid bill is locked, and fully.** Design 012's rule ("a `paid` bill is composition-immutable")
   is kept and closes a gap it had: besides adding, removing or reassigning a transaction, an edit that changes
   a `paid` bill's total (a purchase's amount or type) is refused too, since a `paid` bill reports
   `remaining: 0` and the extra debt would be hidden. Edits that leave the total alone (description, category,
   tags, date within the cycle) stay allowed. A partly paid bill still takes purchases and edits, and its
   `remaining` follows. A change that
   would make the total smaller than what is already paid is refused (`validation`, pointing at
   `revert_bill_payment`), so `paidAmount ≤ total` always holds.

8. **`revert_bill_payment` undoes one payment.** It takes an optional `paymentId`; without it, it undoes the
   latest payment by date. When two payments share the latest date and no `paymentId` is given, it refuses
   (`validation`, listing both ids). Undoing a payment of a `paid` bill flips it back to `closed`, as today.
   A bill with no payment is answered unchanged.

9. **Payment transfers stay protected.** As today, a bill's payment transfer cannot be edited or deleted
   through the transaction tools; `revert_bill_payment` is the only way to remove one. `delete_credit_card`
   removes every payment of every bill of the card.

## Options considered

- **A `partially_paid` status.** Readable, but every reader of `status` (dashboards, budgets, the immutability
  guards) would need a new branch, and "how much" would still need a field. A derived `partiallyPaid` plus
  `paidAmount` / `remaining` says more and breaks nothing.
- **Carry the remainder to the next bill as "saldo anterior".** Closer to a printed fatura, but it creates an
  entry the person did not make, and interest still has to be entered by hand. Rejected for now; the debt is
  already on the card's account.
- **Store `paid_amount` on the bill.** A second copy of what the transfers already say, which can drift when a
  payment is reverted. Rejected: derived, like balances.
- **`revert_bill_payment` undoes all payments.** Simpler, but undoing one mistaken payment would wipe the
  correct ones. Rejected.

## Plan

1. [x] `feat/partial-bill-payment` (PR #298): Decisions 1–9, the migration dropping `bills.payment_transaction_id`, the
       REST mirrors (`POST /api/bills/pay` takes `amount` and `discriminator`; `POST /api/bills/revert` takes
       `paymentId`), the `cards` dashboard showing "pago X de Y" and the remaining amount on a partly paid bill,
       tests, docs.

## Implementation prompt

### Step 1 — `feat/partial-bill-payment`

Read first, in full: this design, Feature Designs 003, 011 and 012, ADR-010, `docs/write-path.md` (bill
payment), `docs/architecture.md` invariant 8, `docs/canonical/*`.

1. **Models** (`models/bill.ts`): `PayBillSchema` gains `amount?` (positive) and `discriminator?`;
   `BillQuerySchema` for revert gains `paymentId?`; `BillPayment` (`id`, `date`, `amount`, `account`);
   the bill view gains `paidAmount`, `remaining`, `partiallyPaid`, `payments`; `paymentTransactionId` stays,
   described as the latest payment. Errors: `amountExceedsRemaining(remaining)`, `ambiguousLatestPayment(ids)`,
   `totalBelowPaid(paid)`.
2. **Logic** (`logic/bill.ts`, pure, declarative): `paymentsOf(bill, transactions, cardAccountId)`,
   `settlement(total, payments, decimals)` → `{ paidAmount, remaining, partiallyPaid }`, `planBillPayment`
   with the chosen amount and the derived key (`logic/idempotency.ts`'s `joinUnambiguously`), `latestPayment`
   (refusing a tie), and the guard that a composition change keeps `paidAmount ≤ total`.
3. **Controllers** (`controllers/credit-card/bill.ts`): `payBill` reads the bill, its payments and the total,
   decides through the logic, and writes the transfer plus the bill update (status `paid` only when remaining
   reaches 0) in one batch, with a version check on the bill so two concurrent payments cannot overpay
   together. `revertBillPayment` removes the chosen payment and, from `paid`, flips the bill to `closed`. The
   card-transaction flows (`update_card_transaction`, `delete_card_transaction`, and a purchase landing on the
   bill) use the new guard; their "paid bill" checks stay.
4. **Schema**: a migration first sets `transactions.bill_id` from `bills.payment_transaction_id` where the
   transfer has none, then drops the column (listed in `DATA_REWRITING_MIGRATIONS`, so the database is copied
   first); `delete_credit_card` finds payments through the transfers.
5. **Edges**: the MCP tools and REST mirrors take the new inputs; descriptions say what remains, that a
   remainder stays as card debt and that interest is recorded as a card charge.
6. **UI**: `ui/dashboards/cards.html` shows "pago X de Y" and the remaining amount for a partly paid bill,
   through the shell's classes and `window.PATTY`.
7. **Tests**: a payment below the total leaves the bill `closed` with `partiallyPaid`, then a second one makes
   it `paid`; no `amount` pays the remaining; an amount above remaining is refused; a repeat with the same
   inputs is idempotent and a `discriminator` records a second identical payment; revert without `paymentId`
   undoes the latest, refuses a same-date tie, and from `paid` returns to `closed`; a purchase on a partly paid
   bill raises `remaining`; deleting one that would drop the total below `paidAmount` is refused; two
   concurrent payments cannot together exceed the total; the payer's and the card account's balances after
   each step; `delete_credit_card` removes every payment; the migration keeps existing paid bills paid with
   their payment listed, including one whose transfer had no `bill_id` (linked only through the dropped column);
   a `paid` bill with no payment (non-positive total, or a transfer gone) reports `remaining: 0`; the old
   all-or-nothing calls give the same answers as before (pay without `amount`, pay a `paid` bill, revert the
   only payment); the MCP surface and OpenAPI snapshots.
8. **Docs**: `docs/mcp-tools.md` (`pay_bill`, `revert_bill_payment`, `get_bill`), `docs/architecture.md`
   invariant 8, `docs/write-path.md`, this design's status line; Designs 011 and 012 point here for what changed.

### Finish (every push)

The Definition of Done in `CLAUDE.md`: the self-review pass and the gate
(`npm run lint && npm run typecheck && npm run test:all && npm run build && npm run format:check`), results in
the PR description. Feature-sized: dispatch the verification subagent before pushing.
