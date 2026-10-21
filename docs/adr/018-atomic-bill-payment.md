# ADR-018: Atomic bill payment — the last within-aggregate multi-write, closed locally

**Status:** Superseded by **ADR-021** (before implementation — the atomicity sought here is generic in the
imperative shell, not a transactional repo method) · **Date:** 2026-07-11 · **Deciders:** Rafael · Closes the
concurrency thread parked when
**ADR-015** (cross-cutting unit-of-work + optimistic versioning) was rejected in favor of the ADR-016/017
boundary work. That work shrank the multi-write surface exactly as predicted; this ADR resolves the single
residue.

## Context

ADR-015 was rejected because the multi-write flows it targeted were non-atomic largely *because* the wrong
module owned them — a concurrency mechanism laid over a cross-domain write had to smuggle sibling-domain rules
into the repo. The boundary refactor (ADR-016/017) moved ownership to the right aggregates and, as predicted,
most surveyed flows collapsed into a single aggregate over one repo transaction. One residue remains.

`payBill` (`controllers/credit-card/bill.ts`) still issues two separate repo writes that are not atomic as a
pair:

```
deps.transactions.create({ …payment transfer, idempotencyKey: `billpay-<billId>` })   // write 1
deps.bills.markPaid(billId, transaction.id)                                            // write 2
```

Process death or a concurrent interleave between them leaves an orphan payment transfer with the bill still
unpaid (or a double-pay race on the bill's status). Mitigations already in place: the transfer's
`billpay-<billId>` idempotency key makes write 1 replay-safe, and `payBill` early-returns if the bill is already
`paid`. But the read→write gap on the bill's status, and the non-atomic pair, remain. (`revertBillPayment` is
already atomic — one `db.transaction` in `bills.revertPayment` — and the zero-total path is a single
`setStatus`.)

The decisive change since ADR-015: **this flow is now entirely inside the credit-card aggregate.** The transfer
is persisted via the shared core primitive (`deps.transactions.create` — aggregate → core, allowed), and the
only invariant to enforce is the *bill's own* status ("don't pay an already-paid bill"). There is no
cross-domain reach, so none of ADR-015's machinery (typed cross-flow deltas, generic row versioning,
controller-side retry) is warranted.

## Decision (proposed)

**Close the gap with a single within-aggregate unit of work: one transactional bill-repo method that inserts the
payment transfer and flips the bill to `paid` in one `db.transaction`, with the flip conditioned on the bill's
current status so a concurrent pay is a mechanical no-op.** No optimistic versioning, no cross-flow delta type,
no retry loop.

1. **One transactional repo method** in the credit-card aggregate's bill repo (e.g. `bills.pay(billId,
   paymentTransferDraft)`): within a single `db.transaction`, insert the payment-transfer row (honoring the
   existing `billpay-<billId>` idempotency `onConflictDoNothing`) and `UPDATE bills SET status = 'paid',
   payment_transaction_id = ? WHERE id = ? AND status != 'paid'`. Both writes commit or neither does.
2. **The double-pay guard is a status-conditioned write, not a domain-rule leak.** `rowsAffected === 0` on the
   conditioned `UPDATE` means the bill was already paid — the repo reports it as data; the controller maps it to
   the existing already-paid outcome. This is the bill repo enforcing the **bill's own** invariant on the
   **bill's own** row — categorically different from the ADR-015 rejection, where the *transaction* repo would
   have had to interpret *bill* policy. No sibling-domain vocabulary enters the repo.
3. **The controller keeps all resolution/validation** (resolve card, paying account, non-credit + currency
   checks, compute total, zero-total short-circuit); it hands the repo a fully-decided payment-transfer draft +
   the billId. The repo stays mechanical.
4. **Scope is exactly `payBill`.** `revertBillPayment` is already atomic; no other flow is touched. No schema
   migration, no versioning column.

## Options Considered

### Option A — Status quo: two writes + idempotency key + early-return (rejected)
Replay-safe but not atomic: a crash between the writes still orphans a transfer, and the status read→write gap
allows a double-pay interleave. The bug ADR-015 was raised for, still open in this one flow.

### Option B — Single within-aggregate `db.transaction` + status-conditioned write (chosen)
| Dimension | Assessment |
| --- | --- |
| Atomicity | Both writes commit or roll back together |
| Race guard | The bill's own status condition (`WHERE status != 'paid'`) — mechanical, no domain leak |
| Layering | Repo enforces the bill's own invariant on its own row; controller owns all policy |
| Cost | One repo method + its test; no migration, no versioning, no retry loop |

### Option C — Revive ADR-015's OCC/versioning (rejected — overkill)
Generic row versioning + controller retry was designed for *cross-aggregate* multi-writes. This flow is
single-aggregate with a single self-owned invariant; a `version` column and retry loop would add machinery with
nothing left to guard across contexts. The boundary refactor is precisely what made C unnecessary.

## Trade-off Analysis

The only tension is "is a status-conditioned write a domain-rule leak into the repo?" — the exact concern that
sank ADR-015. It is not, and the boundary work is why: ADR-015's leak was the *transaction* repo reading and
interpreting *bill* status (a sibling domain's policy). Here the *bill* repo conditions a write on the *bill's*
own status — an aggregate enforcing its own invariant on its own row, which is ordinary repository behavior (the
same shape as the existing `onConflictDoNothing` idempotency convention). With the flow contained in one
aggregate, a single `db.transaction` is both necessary and sufficient; anything heavier is machinery without a
cross-context race to justify it.

## Consequences

- **Closes the ADR-015 concurrency thread.** The recurring partial-write shape is resolved for the last flow
  that had it, with a local fix — vindicating the "fix boundaries first, then concurrency" sequencing.
- **New**: one transactional `bills.pay` repo method; `payBill` hands it a payment-transfer draft + billId and
  maps the already-paid outcome. The `billpay-<billId>` idempotency key stays (replay safety inside the tx).
- **Removed**: the controller-level two-call sequence (`transactions.create` then `bills.markPaid`) — `markPaid`
  folds into the transactional method (or becomes its internal step).
- **No** schema migration, versioning column, delta type, or retry loop.
- **Tests**: concurrency-shaped integration test — two concurrent `payBill`s on the same bill yield exactly one
  payment transfer and one `paid` flip (the second is a mechanical no-op), and a rolled-back attempt leaves no
  orphan transfer. Plus the existing pay/revert coverage, unchanged.
- **Docs**: `docs/architecture.md` (the bill-payment invariant note gains "atomic"); `docs/mcp-tools.md`
  unchanged (no tool-surface change); this ADR's status on acceptance.

## Action Items

1. [ ] Review/accept this ADR (decision review — no implementation in this PR).
2. [ ] On acceptance: add this ADR to the `docs/architecture.md` index (the index lists accepted/rejected ADRs
   only, not proposed ones).
3. [ ] Implement `bills.pay` (single `db.transaction`, status-conditioned) + rewire `payBill`; add the
   concurrency-shaped test; update the `docs/architecture.md` invariant note.
