# Feature Design 012: Transaction ↔ bill assignment

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress · **Branch:** `feat/transaction-bill-assignment` ·
**Date:** 2026-07-03 · Builds on Feature Design 003 (credit-card bill payment) and Feature Design 011
(bill payment lifecycle — `revert_bill_payment`, the paid-bill ⇄ payment-transfer invariant). Governed by
ADR-010 (credit cards as liability accounts) and ADR-012 (per-model errors).

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.
>
> **Mechanism note (2026-07-15):** the feature contract below (auto-assignment, explicit cycle override,
> paid-bill immutability) is unchanged, but the implementation mechanism this doc describes —
> `billsRepo.ensureAndAttach` and its self-heal-on-replay compensation — was replaced by ADR-021 phase 2b
> (`docs/functional-core-imperative-shell.md`): the target bill and the transaction are now decided by the
> domain and applied atomically by the generic unit of work as a `Persistable` batch, so there is no separate
> attach step and no self-heal case left to guard. See `docs/architecture.md`'s invariant 8 and
> `docs/write-path.md` for the current mechanism.

## Context

A card transaction joins a bill (fatura) automatically today: `createTransaction` computes the cycle from the
transaction's `date` and the card's `closingDay`/`dueDay` (`billPeriodFor`, `logic/bill.ts`) and attaches it via
`billsRepo.ensureAndAttach`, which upserts the cycle's bill (created `open` on first touch) and sets
`transactions.bill_id`. There is no way to override this — a late-arriving purchase, or a purchase the user
wants grouped onto a different cycle's fatura on purpose, always lands wherever the date/cycle math puts it.

Design 011 also left a gap on the delete side, explicitly deferred: `delete_transaction` only protects a paid
bill's *payment transfer* (via `bills.payment_transaction_id`) — an ordinary purchase that belongs to an
already-`paid` bill can still be deleted (or, as of today, silently created/attached) with no guard at all,
quietly corrupting the bill's total after the fact.

## Decision

1. **Optional explicit selector.** `create_transaction` and `update_transaction` gain optional `billMonth` +
   `billYear` (the same `month`/`year` shape as `get_bill`/`pay_bill` — reused from `BillQuerySchema`, not
   redefined). Both are required together when either is provided (`assertBillPeriodPaired`). When omitted,
   today's cycle-based auto-assignment is unchanged. When provided, they name the target cycle for the
   transaction's own card; the target bill is auto-created (`open`) via the existing `ensureAndAttach` if it
   doesn't exist yet — no new creation path, full reuse.
2. **Bill assignment is card-only.** A transaction with no credit card (an account transaction) cannot carry
   `billMonth`/`billYear` — rejected with a `validation` error. On `update_transaction` there is still no way to
   *add* a card to an account transaction (unchanged — `UpdateTransactionSchema` has no `card` field), so the
   target card for a reassignment is always the transaction's own, existing `creditCardId`; a transaction can
   never move to another card's bill by construction, not by an extra check.
3. **Paid-bill immutability — reject and instruct, never auto-revert.** A `paid` bill's transaction membership
   is frozen. Any of the following is rejected with a `validation` error naming `revert_bill_payment`:
   - `create_transaction` (explicit selector *or* plain cycle auto-assignment) resolving to a bill that is
     already `paid`.
   - `update_transaction` with `billMonth`/`billYear` moving a transaction **onto** a `paid` bill, or moving one
     **off** a bill that is currently `paid`.
   - `delete_transaction` on **any** transaction whose `bill_id` points at a `paid` bill — not just the payment
     transfer. This subsumes and replaces Design 011's narrower `findByPaymentTransaction` guard: the payment
     transfer's own `bill_id` is set to the bill it pays (`payBill` passes `billId: existing.bill.id` on the
     transfer it creates), so "any transaction on a paid bill" already covers the payment transfer as a special
     case — one guard, not two. The old `bills.findByPaymentTransaction` repo method and its narrower error are
     removed as dead code.

   The only door out of a `paid` bill is the existing, explicit `revert_bill_payment` — never a side effect of
   create/update/delete. This mirrors Design 011's own rule for the payment transfer and extends it to the
   bill's full transaction set.
4. **Totals stay derived — nothing to reconcile.** `computeBillTotal` sums whatever transactions currently carry
   a given `bill_id`; reassigning a transaction (removing it from an old bill, attaching it to a new one) is
   simply a `bill_id` UPDATE, so both bills' totals are correct on the very next `get_bill` read. No stored
   total, no recompute step, no cache to invalidate.
5. **Read visibility.** `TransactionView` gains `billId` (previously written but never read back) so callers can
   see which bill a transaction currently belongs to without a separate `get_bill` round-trip, and so
   create/update responses reflect a reassignment immediately.

## Scope / out of scope

- **In:** `billMonth`/`billYear` on `create_transaction`/`update_transaction`; auto-create-on-assign (reuse);
  paid-bill-immutable guard extended to all three of create/update/delete; `TransactionView.billId`;
  `bills.findById`, `creditCards.findById` (new repo lookups); removal of the now-subsumed
  `findByPaymentTransaction` guard.
- **Out:** editing **other** fields (`amount`, `date`, `category`, …) of a transaction that already belongs to a
  paid bill — unaffected by this change. This is a narrower, separate concern (an amount edit changes a paid
  bill's true total without any reassignment) explicitly not tackled here; if it becomes a real problem, it's
  its own follow-up (a `validation` guard on amount/date edits to a paid-bill transaction), tracked as tech debt
  rather than folded into this PR's already-broad blast radius. Cross-card reassignment (structurally
  impossible, not merely rejected — see Decision 2). Bulk import (`create_transactions_bulk`) is not explicitly
  extended, but transparently inherits the same optional fields and guards since it calls `createTransaction`
  per item under the hood — no separate work, and not separately documented as a bulk-specific feature.

### A deliberate imprecision: idempotent replay against a since-paid bill

The paid-bill check for `create_transaction` runs **before** the idempotent `transactions.create()` write (so a
rejected call never leaves an orphan, unattached transaction row behind). Consequence: if a transaction was
created, its bill later paid, and the exact same `idempotencyKey` + args are replayed afterward, the replay is
now rejected too — even though the underlying row is untouched and nothing would actually change. This is
judged acceptable: idempotency in this codebase exists to prevent duplicate financial records on retry, not to
guarantee an already-succeeded call stays magically re-runnable forever after the world around it changed. The
alternative (checking only when a row is genuinely new) risks leaving a real orphan transaction with no bill
attached whenever the target turns out to be paid, which is strictly worse.

### Closing the remaining race: the controller's pre-check is advisory, `ensureAndAttach` is authoritative

The controller-level paid-bill check (`findByCycle` + `guard`) runs before the write for a fast, clean rejection
in the common case, but it is a separate DB round-trip from the later `ensureAndAttach` call — under concurrent
requests, a `pay_bill` could complete in the gap between the two, and the stale pre-check would let the write
through. `bills.ensureAndAttach` closes this: it re-checks status **inside the same `db.transaction`** as the
upsert-and-attach, and returns `null` (never attaches) if either bill is paid by the time it runs — the
check-then-write is atomic at the SQL level, not just "checked early in the request." "Either bill" is
deliberate: for a reassignment, the race isn't only "does the *target* bill become paid mid-flight" (closed by
re-checking the target inside the transaction) — the transaction's *current* bill can equally become paid in
that same gap, which would let it be silently moved off a now-paid bill. `ensureAndAttach` also looks up the
transaction's current `bill_id` (if any) inside the same transaction and refuses if that bill is paid, before
ever touching the target. A fresh insert or a self-heal attach has no current bill yet, so this check is a
no-op there — it only bites on an actual reassignment. Both callers treat `null` as the authoritative
`paidBillImmutable` rejection: `createTransaction` deletes the just-inserted transaction row first (preserving
"no orphans" even on this rare race); `updateTransaction` calls `ensureAndAttach` **before** the main
`deps.transactions.update(...)` write, so this rare-race rejection surfaces before any other field is written —
not after, which would otherwise mutate the transaction's other patched fields (amount, category, …) and still
return a client-visible error for the same request.

## Consequences

- **No schema/migration.** `transactions.bill_id` already exists (used by `ensureAndAttach` since Design 003);
  this feature only adds a controllable *target* and read visibility, no new column.
- **`logic/bill.ts`:** `billPeriodFor` is refactored to share its close/due-date math with a new
  `billPeriodForCycle(month, year, closingDay, dueDay)` (explicit-cycle variant, no transaction date needed) —
  extracted, not duplicated. New pure `isBillPaid(bill)`.
- **`logic/transaction.ts`:** new pure predicates `assertBillPeriodPaired`, `assertBillAssignmentHasCard`.
- **`controllers/transactions.ts`:** `createTransaction` and `updateTransaction` resolve the target bill period
  (explicit or auto), check it isn't `paid`, and (on update) also check the transaction's *current* bill isn't
  `paid` before allowing a move. `deleteTransaction`'s guard is replaced (not extended) — see Decision 3.
- **Blast radius:** `models/transaction.ts` (new fields + errors), `logic/{bill,transaction}.ts`,
  `controllers/transactions.ts`, `diplomat/db/repos/{bills,creditCards}.ts` (new lookups),
  `wire/db/transactions.ts` + `adapters/transactions.ts` (`bill_id` now decoded, was previously dropped),
  `docs/{architecture,mcp-tools}.md`. No changes to `controllers/bills.ts`, `diplomat/mcp/server.ts`, or
  `diplomat/http/routes.ts` schema wiring — both diplomats derive `inputSchema`/wire shapes from the model
  `.shape`, so the new optional fields flow through automatically; only their doc comments change.

---

## Implementation prompt

> Hand this section to a coding agent. The design above is the source of truth; read
> `docs/diplomatic-architecture.md`, `docs/code-quality.md`, `docs/code-style.md`, `docs/architecture.md`,
> ADR-010, ADR-012, and Design 011 first. Work on branch `feat/transaction-bill-assignment`.

### Steps

1. **`logic/bill.ts`:** extract a private `periodFor(month, year, closingDay, dueDay): BillPeriod` from
   `billPeriodFor`'s close/due-date math; reuse it from both `billPeriodFor` (unchanged behavior) and the new
   exported `billPeriodForCycle(month, year, closingDay, dueDay)`. Add `isBillPaid(bill: Pick<Bill, 'status'>):
   boolean`.
2. **`logic/transaction.ts`:** add `assertBillPeriodPaired(input: {billMonth?: number; billYear?: number}):
   boolean` and `assertBillAssignmentHasCard(billMonth: number | undefined, hasCard: boolean): boolean`.
3. **`models/transaction.ts`:** import `BillQuerySchema` from `./bill.js`; add `billMonth:
   BillQuerySchema.shape.month.optional()` / `billYear: BillQuerySchema.shape.year.optional()` (paired
   `.describe()`s) to `CreateTransactionSchema` and `UpdateTransactionSchema`. Add `billId: Id.optional()` to
   `TransactionViewSchema`. Add errors to `transactionErrors`: `billPeriodIncomplete`,
   `billAssignmentRequiresCard`, `paidBillImmutable` (generic wording covering add/remove/reassign, naming
   `revert_bill_payment`). Remove `billPaymentTransferProtected` (superseded).
4. **`wire/db/transactions.ts`:** add `bill_id: z.string().nullable()` to `TransactionRowSchema` (was previously
   present in the SELECT but silently dropped — update the schema's comment accordingly).
   **`adapters/transactions.ts`:** map `billId: row.bill_id ?? undefined` in `dbToModel`.
5. **`diplomat/db/repos/bills.ts`:** expose `findById(billId): Promise<Bill | null>` (reuse the existing private
   `fetchBillById`). Remove `findByPaymentTransaction` (dead after step 7).
   **`diplomat/db/repos/credit-cards.ts`:** add `findById(id): Promise<CreditCard | null>` (mirrors
   `findByName`).
6. **`controllers/transactions.ts`:**
   - `createTransaction`: after `guard(assertExclusiveCategorySubCategory...)`, add
     `guard(assertBillPeriodPaired(input), ...)` and `guard(assertBillAssignmentHasCard(input.billMonth,
     !!input.card), ...)`. After computing `date`/`today` and resolving `card`, if `card` is set, resolve
     `billPeriod` (explicit `billPeriodForCycle` when `billMonth`/`billYear` given, else the existing
     `billPeriodFor(date, ...)`), look up the target bill via the lightweight `deps.bills.findByCycle` (not
     `.get`, which also loads the bill's full transaction list — needless for a status check), and
     `guard(!targetBill || !isBillPaid(targetBill), transactionErrors.paidBillImmutable)` — **before** calling
     `deps.transactions.create(...)** (see the "deliberate imprecision" note — never create an orphan row).
     After the create call, keep attaching via `ensureAndAttach` when `card && created`, and patch the response
     transaction's `billId` from the returned bill so the create response isn't stale.
   - `updateTransaction`: add the same pairing/has-card guards. When `billMonth`/`billYear` is given: guard the
     transaction's *current* bill (`existing.billId`) isn't paid (a small repo-touching `assertBillNotPaid(deps,
     billId)` helper — `true` when `billId` is unset or its bill isn't `paid`; reused by `deleteTransaction`
     too), resolve the target card via `deps.creditCards.findById(existing.cardId)`, compute the target period,
     and guard the target bill isn't paid. Do the actual `ensureAndAttach` call **before** the main
     `deps.transactions.update(...)` write: `ensureAndAttach` re-checks paid status atomically and can still
     block on a race the two pre-checks above missed (a concurrent `pay_bill` landing in between), and that
     block must reject the request before any other field is written — otherwise the client sees an error
     response for a write that had already partially committed. Patch the returned view's `billId` before
     localizing.
   - `deleteTransaction`: replace the `assertNotBillPayment`/`findByPaymentTransaction` guard with
     `guard(await assertBillNotPaid(deps, existing.billId), transactionErrors.paidBillImmutable)`.
7. **Docs:** `docs/mcp-tools.md` (`create_transaction`/`update_transaction` — the new fields, paid-bill rule;
   `delete_transaction` — broaden the existing Design 011 note from "payment transfer" to "any transaction on a
   paid bill"), `docs/architecture.md` (invariant #8 — extend from "payment transfer only" to the full
   composition-immutability rule; mention `bill_id` is now readable on `TransactionView`). This design doc's
   Implementation status → `Done` on merge.

### Tests

- **Unit:** `logic/bill.test.ts` — `billPeriodForCycle` (mirrors the existing `billPeriodFor` cases without a
  transaction date), `isBillPaid`. `logic/transaction.test.ts` — `assertBillPeriodPaired`,
  `assertBillAssignmentHasCard`.
- **Integration (MCP):** assign a bill at create via `billMonth`/`billYear` (target bill auto-created); reassign
  via `update_transaction` (old and new bill totals both correct via `get_bill` afterward); reject `billMonth`
  without `billYear` (and vice versa); reject assigning a non-card (account) transaction to a bill at create and
  at update; reject `create_transaction` landing (by explicit selector *or* plain date-based auto-assignment) on
  a `paid` bill; reject `update_transaction` moving a transaction onto a `paid` bill; reject `update_transaction`
  moving a transaction off a bill that is currently `paid`; reject `delete_transaction` on an ordinary purchase
  belonging to a `paid` bill (not just the payment transfer — regression-proves Decision 3's broadened guard);
  regression: `delete_transaction`/`create_transaction`/`update_transaction` on non-paid-bill transactions are
  unaffected. Full flow: `revert_bill_payment` → reassign a transaction → `pay_bill` again succeeds. OpenAPI
  parity stays green (generic test, no new assertions needed).

### Invariants — do not break

- A `paid` bill is composition-immutable: no add, remove, or reassign of its transactions by any path other
  than the explicit `revert_bill_payment` — never triggered as a side effect of create/update/delete.
- A transaction can only ever be assigned to a bill belonging to its own card (structural, not an extra check).
- Auto-assignment (cycle-from-date) remains the default when no `billMonth`/`billYear` is given.
- Bill totals stay fully derived; no stored total to keep in sync.
- Diplomatic layering; per-model errors composed into `AppError`; constants over literals; thin diplomats
  (no `diplomat/mcp`/`diplomat/http` schema-wiring changes needed — see Consequences).

### Finish

Conventional Commits (`feat(transactions): assign transactions to a specific bill; paid bills immutable`).
Definition of Done (CLAUDE.md): self-review pass + the gate (`lint && typecheck && test:all && build`) +
`format:check` before every push; feature-sized (touches multiple layers, a repo change, and a guard rewrite)
→ run the independent verification subagent before pushing — it should specifically confirm no auto-revert path
exists anywhere, the delete-guard replacement is a strict superset of Design 011's narrower check (no
regression on protecting the payment transfer itself), and cross-card reassignment is truly structurally
impossible. Push, open a PR to `main` stating the DoD results and the paid-bill-immutable invariant. Reply to
review threads with the resolving commit SHA per CLAUDE.md.
