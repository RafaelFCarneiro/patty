# ADR-019: Minimal transaction core — aggregates compose the movement schema up, not derive it down

**Status:** Accepted (2026-07-12; step 1 — schema compose-up — implemented; step 2 — logic re-homing — pending) ·
**Date:** 2026-07-11 · **Deciders:** Rafael · Completes the context-wide boundary of
**ADR-016** at the schema/logic/error layer. ADR-016/017 moved controllers, tools, and the aggregate-specific
schemas to their contexts, but the shared *base* schema and the logic/errors it drags along still carry the
union of every context's vocabulary. This ADR finishes the boundary where it was left half-applied.

## Context

ADR-016's boundary is explicitly context-wide ("runs through every layer — `models/`, `logic/`, `adapters/`,
`wire/*`, `controllers/`, `diplomat/db`"). Controllers and tools were fully decomposed. The schema/logic/error
layer was not: the transaction core still owns a **god base schema** from which aggregates derive by
**subtraction**.

```ts
// models/transaction.ts (core) — carries the UNION of every context's fields
CreateTransactionSchema = z.object({ …shared…, account, card, billMonth, billYear })
UpdateTransactionSchema = z.object({ …shared…, account, billMonth, billYear })

// aggregates carve it DOWN
AddCardPurchaseSchema      = CreateTransactionSchema.omit({ account })            // models/creditCard.ts
AddAccountMovementSchema   = CreateTransactionSchema.omit({ card, billMonth, billYear })  // models/account.ts
UpdateCardTransactionSchema    = UpdateTransactionSchema.strict()
UpdateAccountTransactionSchema = UpdateTransactionSchema.omit({ billMonth, billYear })
```

The ownership is inverted: the core knows every context's fields, and each context removes what isn't its own.
Because the card/bill/account fields live in the core base, the **logic and errors that serve them live in the
core too**, and stay there as a cascade:

- `logic/transaction.ts`: `resolveCurrency(account, card, …)`, `assertBillPeriodPaired`, `withBillId`,
  `isCardOwned`, `guardTransferMutability`, `resolveEffectiveType`.
- `transactionErrors`: `transferTypeImmutable`, `transferCategoryRejected`, `billPeriodIncomplete`,
  `billAssignmentRequiresCard`.

Even the in-code justification for keeping `billAssignmentRequiresCard` in core ("the core itself must be able
to raise it") is a **symptom**: the core update only has to reject `billMonth` because the god base still hands
it a `billMonth` field to reject. Remove the field from the base and the rejection has nothing to guard. This is
the models/logic analogue of the god controller that ADR-016/017 spent five steps removing — the same leak, one
layer down.

## Decision (proposed)

**Invert the derivation. The transaction core is the *minimal shared ledger*: its movement schema, logic, and
errors carry only genuinely-shared vocabulary. Each context ADDS its own fields by composing UP from the core
(`.extend`), never the core carrying a union that aggregates carve DOWN (`.omit`).**

### The bright line

A field, rule, or error is **core** only if the shared read / balance / summary / persistence side is genuinely
defined over it. Anything a single context introduces lives in that context and composes onto the core; the core
never names a sibling context's vocabulary.

### Minimal core movement schema

```ts
// models/transaction.ts — ONLY the shared movement vocabulary
CreateTransactionSchema = z.object({
  description, amount, type /* MovementType: expense|income */, status, date,
  ...CategoryFieldsSchema.shape, currency, idempotencyKey, rawInput, note, tags,
})
// no account, no card, no billMonth/billYear

// credit-card context ADDS its fields
AddCardPurchaseSchema     = CreateTransactionSchema.extend({ card, billMonth, billYear })   // models/creditCard.ts
UpdateCardTransactionSchema = UpdateTransactionSchema.extend({ billMonth, billYear })

// account context ADDS its field
AddAccountMovementSchema  = CreateTransactionSchema.extend({ account })                      // models/account.ts
UpdateAccountTransactionSchema = UpdateTransactionSchema  // no context fields to add
```

The aggregate schemas end up with the **same effective shape** they have today — this is a pure re-homing of
vocabulary, behavior-preserving — but ownership now points the right way and each context's model file is the
single source for its own fields.

### The three settled sub-decisions

1. **`isCardOwned` → credit-card context.** The ownership discriminator (`cardId || billId`) encodes card
   semantics; it moves to the credit-card context's logic, even though it reads the shared `TransactionView`.
2. **Currency resolution → a shared `logic/money.ts`.** `resolveCurrency` is not transaction-core and not
   card/account-specific — currency is a cross-cutting *money* concern (there is already a money *model*). A new
   `logic/money.ts` owns currency resolution and is reused by the card and account contexts. Not duplicated
   per-context, not left in the transaction core.
3. **Transfer: policy moves, the row kind stays core.** Transfer *policy* — `guardTransferMutability`,
   `transferTypeImmutable`, `transferCategoryRejected`, `resolveEffectiveType`'s transfer branch, and the
   create/update/delete transfer flows and their schema — moves to the **account context**. The transfer *row
   kind* stays **core ledger vocabulary**: `TransactionType` (`expense|income|transfer`), the balance math
   (`logic/balance.ts`, the repo's `transfersIn/Out` balance SQL), the summary/aggregate transfer exclusion, and
   `TransactionView.toAccountId` all stay core, because the shared read/balance side is *structurally defined
   over* the transfer kind — the same justification that keeps `cardId`/`billId` read discriminators on the
   shared `TransactionView` (ADR-017). Moving the type constant out would force `core → account` back-references
   in the balance/summary layer; the friction of attempting it is precisely what proves the kind is core.

### What stays core (the minimal shared ledger)

Shared movement fields; `TransactionType` incl. `transfer` + its labels; `TransactionView` with all read
discriminators (`accountId`/`cardId`/`billId`/`toAccountId`); balance/summary/aggregate math; the core
persistence primitives (create/patch/delete a row + tags). None of these name a single context's *policy*.

## Options Considered

### Option A — Status quo: god base schema, aggregates derive by subtraction (rejected)
The core owns every context's fields and the logic/errors that serve them; contexts `.omit` what isn't theirs.
The schema/logic analogue of the god controller — inverted ownership, and the cascade that keeps bill/transfer
logic in core.

### Option B — Minimal core, aggregates compose up with `.extend` (chosen)
| Dimension | Assessment |
| --- | --- |
| Ownership | Correct — each context owns its fields/logic/errors; core owns only shared ledger vocabulary |
| Duplication | None — genuinely-shared fields stay in one core base the contexts extend |
| Direction | `context → core` everywhere; core names no sibling context |
| Cost | Mechanical, behavior-preserving re-homing across model/logic/error files |

### Option C — Fully distributed: each context defines its whole movement schema independently (rejected)
No shared base at all. Duplicates the genuinely-shared movement fields (description/amount/date/…) across every
context and loses the single source for shared vocabulary. The minimal core base *is* that shared vocabulary;
removing it trades a real leak for real duplication.

## Trade-off Analysis

The tension is **a shared base (DRY) vs. context ownership**. The god base looked DRY but bought it by inverting
ownership — the core had to know card, bill, and account fields to let each context subtract the rest. Compose-up
is equally DRY (the shared fields still live once, in the core base the contexts extend) *and* correctly
directed (a context names its own fields; the core names none of theirs). `.extend` and `.omit` are both
one-liners; the difference is entirely which way the dependency points. Option C over-corrects into duplication.
Option B is the only one that keeps a single home for shared vocabulary while giving each context sole ownership
of its own — which is what "context-wide boundary" already committed us to.

## Consequences

- **Core shrinks** to the shared movement schema, `TransactionType` + labels, `TransactionView`, balance/summary
  math, and persistence primitives. Card/bill fields + logic (`assertBillPeriodPaired`, `withBillId`, bill
  errors), the `account` field, transfer policy (`guardTransferMutability`, transfer errors), and `isCardOwned`
  move to their contexts; `resolveCurrency` moves to `logic/money.ts`.
- **The "core must reject bill fields" guards/comments dissolve** — a minimal core never receives `billMonth`, so
  there is nothing to reject; only the card update schema carries those fields, and the account update schema
  structurally can't.
- **Behavior-preserving.** Aggregate schemas keep their effective shape; validation, error codes, and outputs are
  unchanged. This is re-homing, not a contract change — no tool/REST surface change.
- **New**: `logic/money.ts` (currency resolution), reused by card and account contexts.
- **Invariant** (added to `docs/architecture.md` dependency table on acceptance): *the transaction core's
  movement schema/logic/errors carry only shared ledger vocabulary; aggregate schemas `.extend` the core, never
  the core `.omit`-ing context fields; the core names no sibling context's policy. Transfer is the boundary
  case — its row kind is core ledger vocabulary (balance/summary/read are defined over it), its policy is
  account-context.*
- **Docs**: `docs/architecture.md` (dependency-table model/logic ownership rows + the invariant),
  `docs/code-style.md` (the compose-up rule with the `.extend`-not-`.omit` example), this ADR's status on
  acceptance.

## Migration plan (incremental — behavior-preserving; each PR behind the full gate + coverage parity)

1. **Minimal core schema + compose-up**: strip `account`/`card`/`billMonth`/`billYear` from
   `CreateTransactionSchema`/`UpdateTransactionSchema`; rebuild the aggregate schemas with `.extend` in their own
   model files; move the field-level errors (`billPeriodIncomplete`, `billAssignmentRequiresCard`) to the card
   context. Retire the now-dead core rejection guards.
2. **Logic re-homing**: `assertBillPeriodPaired`/`withBillId` → credit-card context; `guardTransferMutability` +
   transfer errors + `resolveEffectiveType`'s transfer branch → account context; `isCardOwned` → credit-card
   context; `resolveCurrency` → `logic/money.ts`. Transfer *kind* handling (balance/summary/`TransactionType`)
   stays put.
3. **Docs + dependency-table invariant.**

Each step is a pure re-home with its tests moving alongside; no behavior change, so coverage parity means the
same assertions pass from their new homes.

## Action Items

1. [x] Review/accept this ADR (decision review — no implementation in this PR).
2. [x] On acceptance: add this ADR to the `docs/architecture.md` index (accepted/rejected only), plus the
   dependency-table invariant + compose-up rule in `docs/architecture.md` / `docs/code-style.md`.
3. [x] Implement step 1 (schema compose-up). [ ] Implement step 2 (logic re-homing) — separate PR.
