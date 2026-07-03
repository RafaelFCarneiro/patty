# Feature Design 011: Bill payment lifecycle (revert + protect + total)

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress · **Branch:** `feat/bill-payment-lifecycle` ·
**Date:** 2026-07-03 · Builds on Feature Design 003 (credit-card bill payment) and **ADR-010**
(credit cards as liability accounts; bill payment = canonical transfer). Preserves ADR-002 (transfers) and
follows ADR-012 (per-model errors).

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

Design 003 shipped `pay_bill`: it creates a canonical transfer (payer account → card's internal `credit`
account) for the bill total and marks the bill `paid`. Three gaps remain from that design, surfaced by usage:

1. **No way back.** Once a bill is `paid`, there is no supported way to undo a mis-payment (wrong account,
   wrong amount because a late purchase landed after paying) short of manually deleting the transfer
   transaction via `delete_transaction` and manually flipping the bill's status back — and the bill's status
   can't even be flipped back today (`setStatus` is internal, not exposed).
2. **The payment transfer is not protected.** `delete_transaction` has no knowledge that a transfer might be
   a bill's payment. Deleting it directly leaves the bill `paid` with no corresponding transfer — the payer's
   balance silently reverts (transfer-out disappears) while the bill still claims to be settled. That's a
   correctness bug waiting to happen from an agent (or user) reaching for the generic delete tool.
3. **`get_bill` already returns `total`** (`computeBillTotal` over the bill's transactions, added
   alongside Design 003) — verified in code; no change needed there. This design's remaining scope is
   items 1 and 2.

## Decision

1. **Bill records its own payment transfer.** `bills` gains a nullable `payment_transaction_id` FK →
   `transactions.id`, mirroring the existing `transactions.bill_id` FK the other direction. Set when
   `pay_bill` actually creates a transfer (total `> 0`); left `null` when a bill is marked paid with a
   non-positive total (Design 003's existing no-transfer branch — unchanged). Cleared back to `null` on
   revert.
2. **`revert_bill_payment` is the only supported undo.** Input mirrors `pay_bill`'s query shape (`card`,
   `month`, `year` — no `account`, since undo doesn't need a payer). Behavior:
   - Bill not `paid` → **no-op success**, returns the bill unchanged (idempotent, mirrors `pay_bill`'s own
     idempotency).
   - Bill `paid` with a linked `payment_transaction_id` → **atomically** delete that transaction and flip the
     bill `paid → closed`.
   - Bill `paid` with no linked transaction (the non-positive-total branch) → flip `paid → closed`, nothing
     to delete. This is the symmetric inverse of `pay_bill`'s own no-transfer branch, so revert stays total
     across both of `pay_bill`'s outcomes.
3. **Clean delete-undo, not a status flag on the transaction.** Reverting *deletes* the payment transfer
   (same "clean" philosophy as `delete_credit_card`'s hard delete in Design 003) rather than introducing a
   `reverted`/`voided` transaction status. This keeps balances, summaries, and `search_transactions` correct
   with zero new state to reconcile — after revert, it is exactly as if the payment never happened. The
   `idempotencyKey: billpay-<billId>` is freed by the delete, so paying again after a revert re-inserts
   cleanly (no idempotency collision).
4. **Protect the payment transfer from direct deletion.** `delete_transaction` looks up whether the target
   id is *any* bill's `payment_transaction_id`; if so, it rejects with a `validation` error before even
   entering the dry-run flow, pointing the caller at `revert_bill_payment`. Deleting any other transaction —
   including ordinary transfers and card purchases — is unaffected.
5. **Invariant (revised from Design 003's simpler "no payment transaction exists" framing):** a `paid` bill
   has **at most one** payment transfer, and that transfer (when present) is only ever created by `pay_bill`
   and only ever removed by `revert_bill_payment`. It is never zero-or-many; it is exactly the transfer
   referenced by `payment_transaction_id`, or absent for a non-positive-total bill. `pay_bill` and
   `revert_bill_payment` are exact inverses on the `paid ⇄ closed` transition; both are idempotent no-ops
   outside that transition.

## Scope / out of scope

- **In:** `bills.payment_transaction_id` (schema + migration); `revert_bill_payment` controller + MCP tool +
  `POST /api/bills/revert`; `delete_transaction` protection for payment transfers; docs.
- **Out (deferred):** deleting/editing individual purchases that belong to an already-paid bill (this needs
  the transaction↔bill assignment/reconciliation work — recompute or reject when the bill total would
  change after `paid` — tracked separately, not part of this change); partial payments (Design 003's existing
  deferral, unaffected); re-opening a `closed` (unpaid, cycle-ended) bill back to `open` (out of scope — closed
  bills are not addressed by this design, only the `paid ⇄ closed` edge).

## Consequences

- **Schema/migration:** `bills` gains `payment_transaction_id` (nullable FK → `transactions.id`). Generated
  via `drizzle-kit`. `models/bill.ts`'s `Bill` entity gains an optional `paymentTransactionId` — it flows
  through to `get_bill`/`pay_bill`/`revert_bill_payment` responses as ordinary entity state (no new wire
  shape needed).
- **Repo:** `diplomat/db/repos/bills.ts` gains `markPaid` (sets `status: paid` + `payment_transaction_id`
  together — replaces the plain `setStatus(paid)` call on `pay_bill`'s transfer branch), `revertPayment`
  (atomic delete-transaction + `status: closed` + clear the FK, same `db.transaction` pattern already used by
  `creditCardsRepo.deleteCard`), and `findByPaymentTransaction` (existence check for the delete guard).
  `setStatus` is kept for the no-transfer paid/revert branches.
- **Controllers:** `payBill` now captures the created transfer's id and calls `markPaid` instead of
  `setStatus` on the transfer branch. New `revertBillPayment`. `deleteTransaction` gains a guard.
- **Blast radius:** `models/bill.ts`, `models/transaction.ts` (new error), `schema.ts` + migration,
  `diplomat/db/repos/bills.ts`, `controllers/{bills,transactions}.ts`, `diplomat/mcp/server.ts`,
  `diplomat/http/routes.ts`, `docs/{architecture,mcp-tools}.md`. No change to balance/summary queries,
  classification, or `create_transfer`.

---

## Implementation prompt

> Hand this section to a coding agent. The design above is the source of truth; read
> `docs/diplomatic-architecture.md`, `docs/code-quality.md`, `docs/code-style.md`, `docs/architecture.md`,
> ADR-010, ADR-012, and Design 003 first. Work on branch `feat/bill-payment-lifecycle`.

### Steps

1. **Schema** (`src/diplomat/db/schema.ts`): add `paymentTransactionId: text('payment_transaction_id')
   .references(() => transactions.id)` to the `bills` table (nullable). Generate the migration
   (`drizzle-kit generate`).
2. **`wire/db/bills.ts`**: add `payment_transaction_id: z.string().nullable()` to `BillRowSchema`.
3. **`models/bill.ts`**: add `paymentTransactionId: Id.optional()` to `BillSchema` with a `.describe()`
   explaining when it's absent (open/closed bills; paid bills with a non-positive total).
4. **`diplomat/db/repos/bills.ts`**: extract a small shared `fetchBillById` used by `setStatus`/`markPaid`/
   `revertPayment` (avoid repeating the re-select). Add `markPaid(billId, transactionId)`, `revertPayment
   (billId, transactionId)` (atomic: delete `transaction_tags` for the transfer, delete the transfer, update
   the bill to `closed` + null FK — mirror `creditCardsRepo.deleteCard`'s `db.transaction` + FK-safe order),
   and `findByPaymentTransaction(transactionId): Promise<Bill | null>`. Update `toBill` to map the new
   column.
5. **`controllers/bills.ts`**: in `payBill`'s transfer branch, capture `{ transaction }` from
   `deps.transactions.create(...)` (currently discarded) and call `deps.bills.markPaid(existing.bill.id,
   transaction.id)` instead of `setStatus`. Add `revertBillPayment(deps, input: BillQuery)`: not-paid → return
   the bill unchanged; paid + `paymentTransactionId` → `deps.bills.revertPayment(...)`; paid + no
   `paymentTransactionId` → `deps.bills.setStatus(billId, BillStatus.enum.closed)`.
6. **`models/transaction.ts`**: add a `validation` error to `transactionErrors`
   (`billPaymentTransferProtected`) instructing the caller to use `revert_bill_payment`.
7. **`controllers/transactions.ts`**: in `deleteTransaction`, after resolving `existing`, add a repo-touching
   guard (small async helper, mirrors `assertCardNameAvailable`'s shape) that rejects when
   `deps.bills.findByPaymentTransaction(input.id)` finds a bill — before the dry-run branch, so a protected
   transaction never reaches the dry-run/confirm flow.
8. **Surface:** register `revert_bill_payment` (MCP, `diplomat/mcp/server.ts`, next to `pay_bill`) and
   `POST /api/bills/revert` (REST, `diplomat/http/routes.ts`, next to `/api/bills/pay`; input reuses the
   existing `BillQuery` wire schema — no `account` field). Register the REST route in the same
   `buildRouteDefinitions` array (OpenAPI parity is automatic).
9. **Docs:** `docs/mcp-tools.md` (`revert_bill_payment` section), `docs/architecture.md` (the new FK +
   invariant #8 refinement), this file's Implementation status → `Done` on merge.

### Tests

- **Unit:** any new pure helper (unlikely — this is mostly repo/controller orchestration; if a guard
  predicate ends up pure, colocate its test).
- **Integration** (MCP, mirrors `test/integration/mcp/bill-payment.test.ts`):
  - pay → revert: bill flips back to `closed`, the transfer is gone (`search_transactions` no longer returns
    it), payer and card-account balances return to pre-pay values.
  - revert on a bill that was never paid → success no-op, bill unchanged, status stays as-is.
  - revert on a bill paid via the non-positive-total branch (no transfer) → flips to `closed`, no error.
  - `delete_transaction` on the payment transfer id → `validation` error mentioning `revert_bill_payment`;
    the transfer still exists afterward.
  - `delete_transaction` on an ordinary (non-bill) transfer still deletes normally (regression check).
  - `get_bill` total is correct for a multi-transaction bill (regression check — already implemented, cover
    it since it was untested).
  - pay → revert → pay again succeeds (idempotency key freed by the delete).
  - REST: `POST /api/bills/revert` mirrors the MCP behavior (paid → reverted, not-paid → no-op).
  - OpenAPI parity test stays green with the new route (no new test needed if the existing parity test is
    generic over `buildRouteDefinitions`).

### Invariants — do not break

- A `paid` bill has **at most one** payment transfer, created only by `pay_bill`, removed only by
  `revert_bill_payment`; `payment_transaction_id` is the single source of truth for which transaction it is.
- `pay_bill` / `revert_bill_payment` are exact inverses on `paid ⇄ closed`; both idempotent no-ops outside
  that transition.
- The payment transfer is never removable via `delete_transaction`.
- Per-currency; payment amount equals the bill total at pay time (unchanged); `pay_bill` stays idempotent.
- Diplomatic layering; per-model errors (ADR-012); constants over literals; thin diplomats; `logic/` stays
  pure (this feature is controller/repo orchestration — no new `logic/` functions are anticipated, but if one
  emerges, it must be pure and unit-tested).

### Finish

Conventional Commits (`feat(bills): revert_bill_payment + protect payment transfer + get_bill total`).
Definition of Done (CLAUDE.md): self-review pass + the gate (`lint && typecheck && test:all && build`) before
every push; this is feature-sized (schema/migration + tool/route + a delete guard) → run the independent
verification subagent before pushing. Push, open a PR to `main` stating the DoD results and the paid-bill ⇄
payment-transfer invariant. Reply to review threads with the resolving commit SHA per CLAUDE.md.
