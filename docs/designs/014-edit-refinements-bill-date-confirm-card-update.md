# Feature Design 014: Edit refinements — bill payment date, confirm-with-edit, credit-card update

**Type:** Feature design (a batch of small lifecycle/edit gaps found in testing) · **Design status:** Accepted ·
**Implementation status:** In progress (Phases A, C done) · **Date:** 2026-07-22 · Touches the bill, transaction, and credit-card
domains. Respects **ADR-010** (credit accounts are card-managed), **ADR-020** (ownership by account type,
transfer/bill-payment immutability), and the effective-only balance invariant (**Feature Design 001**).

> **Implementation status** tracks delivery: `Not started` · `In progress` · `Done` · `Blocked`.
> **Delivered as three sequential PRs**, each its own branch off the latest `main`, each independent:
> `feat/bill-payment-date` (A) · `feat/confirm-with-edit` (B) · `feat/update-credit-card` (C).

## Context

Three gaps surfaced during testing. A fourth reported item — "don't allow a credit account as a card's payment
account" — is **already enforced** at both `createCreditCard` and `payBill` via
`assertNonCreditType` → `accountErrors.creditPaymentRejected`; it survives here only as a **guard the new
card-update flow (C) must also carry**, plus a regression test locking all three paths.

A throughline connects two of the three: **an `effective` transaction's date must never be in the future.**
`effective` means "has cleared"; a future date means "hasn't happened yet" — that is precisely what `pending` is
for (the date-aware create default already encodes it). This design promotes that to an explicit, enforced
invariant, and both the bill-payment date (A) and confirm-with-edit (B) respect it.

## Feature A — Bill payment date (`pay_bill`)

**Today:** `payBill` hardcodes the payment transfer's date to `toIsoDate(deps.clock())` (today). There is no way
to record that a bill was paid on a different (past) date.

**Change:**
- `PayBillSchema` gains `paymentDate: IsoDate.optional()` (default: today).
- `payBill` uses `input.paymentDate ?? toIsoDate(deps.clock())` for the transfer's `date`.
- **Guard: `paymentDate` must be ≤ today** (`billErrors.futurePaymentDate` or the shared
  `cannot_confirm_future_dated`-family error). A bill payment records a payment that *occurred*; marking a bill
  `paid` while its transfer is future-dated/`pending` would assert money moved when it hasn't. So the
  bill-payment transfer is always `effective` and dated on/before today — consistent with the invariant below.

*Nothing else changes:* resolution (explicit account → card default → error), the non-credit/currency guards, and
the idempotent no-op on an already-paid bill are untouched.

## Feature B — Confirm with edit + the future-date invariant (`confirm_transaction`)

**Today:** `confirmTransaction({ id })` rebuilds the entity with `status: effective`, keeping `amount`/`date`.
`UpdateTransactionSchema` can edit `amount`/`date` but carries **no `status`**, so no single action reconciles a
pending estimate (correct its amount/date) *and* confirms it.

**Change — keep the tool, route through update (per the chosen approach):**
- `confirm_transaction` **stays the dedicated tool/endpoint** (it is the AI-facing "confirm" verb). Its schema
  gains optional `amount` and `date`.
- The `confirmTransaction` controller no longer hand-rebuilds the entity; it **applies the edit + status flip
  through the transaction update mechanism**, so it inherits the existing ownership/immutability guards
  (ADR-020) rather than re-implementing them in the shared core. Concretely:
  - **Status-only confirm** (no `amount`/`date`) works for any transaction type — unchanged behavior, plus the
    future-date guard below.
  - **Confirm-with-edit** (an `amount`/`date` is supplied) is allowed only where an ordinary update would be:
    account/card movements. Editing a **transfer or bill-payment** transaction's amount/date stays rejected
    (transfer immutability / bill-process ownership, ADR-020) — a plain confirm of such a transaction is still
    fine.
- **The future-date guard (the requested rule):** confirming resolves the effective date (`date ?? existing.date`)
  and **rejects if it is in the future** — `transactionErrors.cannotConfirmFutureDated(date)`. You cannot make a
  transaction `effective` while it is dated ahead of today. *(Chosen over silently clamping to today: mutating a
  user-supplied date without asking is surprising; a clear rejection lets the caller pass today's date or wait.
  Clamp-to-today is the noted alternative if you'd rather.)*

**New invariant (record in `docs/architecture.md`):** *an `effective` transaction's date is never in the future.*
Enforced at confirm (B) and at bill payment (A); the date-aware create default already respects it (future-dated
creates default to `pending`).

### Feature B — concrete controller

**Layering constraint that shapes this.** `confirmTransaction` lives in `controllers/transaction/core.ts`, which
**must not import `controllers/account/*` or `controllers/creditCard/*`** (dependency table — the shared core
never depends on the aggregates). So confirm **cannot delegate** to `updateAccountTransaction`/
`updateCardTransaction`, and the aggregate guards (`assertAccountOwnedLegs`, `guardTransferMutability`, the
bill-payment block) are not reachable from here. "Reuse the update flow passing status" is therefore realized as
a **thin core flow scoped to what confirm actually edits — `amount`/`date` (+ `status`)** — not a re-dispatch. It
does *not* route through `decideTransactionUpdate`, whose work (account/category/type resolution) is entirely
no-ops for confirm: confirm is for reconciling a pending estimate, not reclassifying (that stays `update_*`'s
job).

**Immutability without the aggregate guards.** The one thing confirm must protect is editing an immutable
transaction. Transfers and bill-payment transactions are exactly `type === 'transfer'` (ADR-002) — a
**core-visible** fact needing no ownership resolution. So: **an edit (`amount`/`date` supplied) is rejected when
`isTransfer(existing)`**; a plain status-only confirm of a transfer is still allowed. This is marginally stricter
than `update_account_transaction` (which permits editing a *regular* transfer's amount) — a deliberate, honest
trade: confirm stays in core and pure, and a regular transfer needing an amount correction uses
`update_account_transaction` first, then confirm. The error points there.

**Shape** (extends today's `confirmTransaction`, which already assembles the entity from `existing`):

```
confirm_transaction inputSchema: { id, amount?: Money, date?: IsoDate }

export const confirmTransaction = (deps, input: { id: string; amount?: number; date?: string }) =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const locale = await deps.locale();

    // already cleared → idempotent no-op (unchanged)
    if (existing.status === TransactionStatus.enum.effective)
      return ok({ persist: [], response: addLocalizedLabels(existing, locale) });

    const hasEdit = input.amount !== undefined || input.date !== undefined;
    // transfers / bill-payments are immutable here — plain confirm ok, edit-at-confirm is not
    yield* guard(!(hasEdit && isTransfer(existing)), transactionErrors.confirmEditNotAllowedForTransfer);

    // the invariant: effective ⇒ date not in the future
    const date = input.date ?? existing.date;
    yield* guard(date <= toIsoDate(deps.clock()), transactionErrors.cannotConfirmFutureDated(date));

    // same entity assembly as today, with the two editable fields + status flip
    const entity: TransactionEntity = { ...entityFromExisting(existing),
      amount: input.amount ?? existing.amount, date, status: TransactionStatus.enum.effective };

    return ok({
      persist: [persistence.update({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, version: existing.version } })],
      response: buildTransactionView(locale),
    });
  });
```

`entityFromExisting` is the field mapping confirm already inlines today (spread `existing` into a
`TransactionEntity`); extract it as a tiny local so the amount/date/status overrides read cleanly. `isTransfer`
(pure, `logic/`) and `toIsoDate` are already core-available. ISO `YYYY-MM-DD` compares correctly with `<=`.

**New errors** (`models/transaction.ts`'s `transactionErrors`): `cannotConfirmFutureDated(date)` and
`confirmEditNotAllowedForTransfer` (message: correct a transfer's amount/date via `update_account_transaction`, a
bill payment via `pay_bill`/`revert_bill_payment`, then confirm).

**Why not add `status` to `UpdateTransactionSchema` instead** (rejected): it would expose a raw status flip on the
aggregate update tools and split "confirm" across two surfaces; you asked to keep `confirm_transaction` as the
verb, and the thin-core flow above does that without duplicating edit rules — `amount`/`date` are the only edit
surface, guarded by the same future-date invariant everything else respects.

**Noted future direction (not this design):** if confirm-with-edit needs to grow beyond `amount`/`date` — e.g.
editing a *regular* transfer's amount at confirm, or card-specific reconciliation — the clean move is
**aggregate-specific confirmation flows** (`confirmAccountTransaction`/`confirmCardTransaction`) that live in the
aggregates and reuse their full update guards, with `confirm_transaction` dispatching by resolved ownership at
the diplomat edge. Deliberately deferred: today's thin core flow covers the reconcile-a-pending-estimate case
(account/card movements) without that machinery.

## Feature C — Update a credit card (`update_credit_card`) + the #4 guard

**Today:** there is **no `updateCreditCard`** — cards can be created and deleted but never edited. The requested
"edit name" is the centerpiece; since the flow is the same shape, this delivers the full editable set.

**Change:**
- New `UpdateCreditCardSchema`: identify the card by its current `name`; optional new `name`, `limit`,
  `closingDay`, `dueDay`, `paymentAccount`.
- `updateCreditCard` controller (mirrors `updateAccount`, Feature Design 007):
  - **Rename** → `assertCardNameAvailable(newName)` (→ `cardErrors.duplicateName`), and **cascade to the internal
    account**: the card's internal `credit` account is named `Card: {name}` (ADR-010), so a rename re-emits that
    account under `Card: {newName}` (subject to `assertAccountNameAvailable`). This is a **two-entity update**
    (card + its internal account) — a merged `Persistable` batch (rule 5).
  - **`paymentAccount` change** → resolve, then **`assertNonCreditType` → `creditPaymentRejected`** (the #4 guard)
    + currency-match. Reuses the exact guard `createCreditCard`/`payBill` already carry.
  - **`limit`/`closingDay`/`dueDay`** → plain field updates. **Note:** a `closingDay`/`dueDay` change applies to
    **future** bill cycles only; existing `bills` rows keep their computed boundaries (stated, not silently
    assumed).
- Tool `update_credit_card`.

## Options / decisions settled

- **#2 home** — dedicated `confirm_transaction` tool (your call: keep the verb). Realized as a **thin core flow
  scoped to `amount`/`date`(+`status`)**, *not* a delegation to the aggregate update controllers — the
  dependency table forbids `controllers/transaction/core.ts` from importing them (see Feature B concrete
  controller). Immutability is enforced in-core via `isTransfer` (transfers/bill-payments reject edit-at-confirm),
  not via the aggregate guards. Rejected alternative: exposing raw `status` on the update tools (splits "confirm"
  across two surfaces).
- **Future-dated confirm** — **reject** (primary) vs clamp-to-today (alternative). Reject chosen for
  predictability; flagged so you can flip it.
- **#3 scope** — **full editable set** (no-preference → the complete flow; name is the must-have, the rest is
  marginal once the flow exists).
- **#1 future payment date** — **rejected** (a bill payment is a record of a payment that occurred), keeping the
  bill-paid ⇒ effective-transfer semantics honest.

## Docs to update (in the owning phase's change)

- `docs/architecture.md` — the **effective ⇒ not-future-dated** invariant (new numbered invariant, near the
  effective-only balance invariant); `update_credit_card`'s two-entity rename cascade if it warrants an
  invariant/note.
- `docs/write-path.md` — `confirmTransaction` now routes through the update mechanism (its per-flow note);
  `update_credit_card`'s two-entity batch (alongside `createCreditCard`/`deleteCreditCard`).
- `docs/mcp-tools.md` — `pay_bill` (`paymentDate`), `confirm_transaction` (`amount`/`date`, future-date error),
  `update_credit_card` (schema, error codes, examples).
- This doc's Implementation status per phase.

## Testing

- **A:** pay with an explicit past `paymentDate` → transfer dated then, `effective`; default (omitted) → today;
  future `paymentDate` → rejected; idempotent re-pay unaffected.
- **B:** confirm-only (unchanged); confirm-with-`amount`/`date` on an account/card movement → edited + effective;
  confirm-with-edit on a transfer/bill-payment → rejected (immutability), plain confirm of same still works;
  confirm resolving to a future date → `cannotConfirmFutureDated`; already-effective → no-op.
- **C:** rename → card + internal account both renamed, `/api` lookups by new name work; duplicate new name →
  `duplicateName`; set `paymentAccount` to a **credit** account → `creditPaymentRejected` (**the #4 regression —
  assert create + pay + update all reject it**); limit/closingDay/dueDay edits; closingDay change leaves existing
  bills unchanged.

## Implementation prompt

Three independent PRs; do them in any order, each behind the full gate. Read `docs/write-path.md` before
touching a controller/flow, and `docs/architecture.md` § Write path guardrails. Suggested order
A → C → B (trivial → medium → most-nuanced).

### Phase A — `feat/bill-payment-date`
`PayBillSchema.paymentDate` (optional, ≤ today guard); `payBill` uses it for the transfer date; `docs/mcp-tools.md`.

### Phase B — `feat/confirm-with-edit`
`confirm_transaction` gains optional `amount`/`date`; `confirmTransaction` routes edits + `status: effective`
through the update mechanism (reusing ADR-020 guards); add `transactionErrors.cannotConfirmFutureDated` and the
future-date guard; record the **effective ⇒ not-future-dated** invariant in `docs/architecture.md`; update
`docs/write-path.md` + `docs/mcp-tools.md`. Feature-sized (touches the shared confirm flow + a new invariant) →
independent verification subagent on the diff.

### Phase C — `feat/update-credit-card`
`UpdateCreditCardSchema` + `updateCreditCard` (rename with internal-account cascade + duplicate guard;
`paymentAccount` with `assertNonCreditType`; limit/closingDay/dueDay); `update_credit_card` tool; the #4
regression test across create/pay/update; `docs/architecture.md` (rename cascade), `docs/write-path.md`
(two-entity batch), `docs/mcp-tools.md`. Feature-sized (two-entity write flow) → independent verification
subagent on the diff.

### Finish (every push, every phase)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build`), and report the result before pushing.
