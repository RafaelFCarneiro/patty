# FinTrack v2 — Architecture (as built)

> **This file describes the system as it IS.** Update it in the same change that alters architecture.
> Roadmap and vision: `docs/PLAN.md`. Decisions + rationale: `docs/adr/`. Agent instructions: `CLAUDE.md`.
> Layer concepts: `docs/diplomatic-architecture.md` (where the layers are) and
> `docs/functional-core-imperative-shell.md` (what crosses the write-path boundary between them — ADR-021,
> mandatory reading alongside the Diplomat doc for any write-flow change).

## Stack

TypeScript (ESM, Node 22) · Fastify 5 · zod · neverthrow · remeda · libSQL (encrypted, local-first) · Drizzle ORM.
Surfaces: **MCP (primary)** at `POST /mcp` (streamable HTTP, stateless) and REST at `/api`.

## Diplomat layers

```
diplomat/http (Fastify)   diplomat/mcp (tools)        ← thin edges: parse, delegate, translate
            └────────┬────────┘
              controllers/                            ← effect composition: safeTry pipelines,
            (ResultAsync<T, AppError>)                  shared resolvers (resolve.ts)
        ┌────────────┼────────────┐
   logic/ (pure)  adapters/   diplomat/db (SQL/Drizzle) ← logic: no I/O ever; db: parameterized only
            models/ (zod = single source of truth)
```

FP stack (ADR-001, ADR-003): zod = schemas/decoding · neverthrow = fallible control flow (`safeTry` + `guard`/`okOr`) · remeda = data reshaping in logic/adapters. One concern per library.

## Diplomat alignment in this project

This section records how FinTrack applies Diplomat core concepts in the current codebase.
If any generic concept is ambiguous, this file is the source of truth for implementation choices.

1. Schema stack: zod is the schema system used for models and boundary decoding.
2. Controller dependency style: controllers orchestrate through injected deps interfaces (`controllers/deps.ts`) and must not import `diplomat/` modules directly. **Documented exception**: `import type` of repo contracts from `diplomat/db/repos` is allowed (type-only imports erase at runtime; the contracts live next to their implementations until a dedicated ports module is warranted).
3. Diplomat role: `diplomat/http` and `diplomat/mcp` remain thin edges (parse/delegate/translate), while side effects are composed in controllers via deps. **FinTrack restriction**: unlike the generic Diplomat pattern, controllers here must NOT import `diplomat/` modules — they interact exclusively through injected deps interfaces (`controllers/deps.ts`). The generic dependency table in `docs/diplomatic-architecture.md` lists `diplomat.*` as a valid controller dependency; that does not apply here.
4. Adaptation boundaries: adapters are pure translators for all boundary crossings, not only db. They convert `wire/in -> model`, `model -> wire/out`, and `model <-> wire/db`.
5. Persistence adaptation: controllers hand repos **domain drafts** (models — e.g. `TransactionDraft` with nested `classification`); `diplomat/db` may use adapters internally to flatten model→db and decode db→model. Controllers never build db-wire shapes and never call adapters.
6. Edge flow contract: `diplomat/http`, `diplomat/mcp`, and other diplomats adapt external payloads with wire schemas + adapters before calling controllers, then adapt controller results back to wire/out.

### Dependency direction (enforced)

| Namespace | Can depend on |
| --- | --- |
| `controllers/` | `logic/`, `models/`, `common/`, injected deps interfaces |
| `logic/` | `logic/`, `models/` only |
| `models/` | zod/schema helpers, `models/error.ts` (shared error primitives). Each model defines its own error union and payload builders (ADR-012); models never import the composed `AppError`. |
| `models/creditCard.ts` | Same base `models/` rule, **plus** it may depend on `models/transaction.ts` (ADR-016: the aggregate model may depend on the core model, never the reverse) — `AddCardPurchaseSchema`/`UpdateCardTransactionSchema` `.extend` the core's minimal `CreateTransactionSchema`/`UpdateTransactionSchema` (ADR-019 step 1) with credit-card-only vocabulary the core no longer carries at all: `AddCardPurchaseSchema` adds `card` (required) plus `billMonth`/`billYear`; `UpdateCardTransactionSchema` adds `billMonth`/`billYear` (bill reassignment — there is no `card` field on update, a transaction's card can't change) plus `account`, kept reachable only so `cardErrors.accountChangeRejectedForCard` can fire (see invariant #18). Same for the errors: `cardErrors.paidBillImmutable`/`cardErrors.accountChangeRejectedForCard` are raised exclusively by the credit-card aggregate (`controllers/creditCard/transaction.ts`), never the core, so their payloads live here — and, since ADR-019 step 1, so do `cardErrors.billPeriodIncomplete`/`cardErrors.billAssignmentRequiresCard` (moved from `models/transaction.ts`'s `transactionErrors`, where the core used to raise them itself before the minimal-core change removed the fields that made that necessary). This mirrors the controller-layer arrow at the schema/error-vocabulary layer: hosting an aggregate-exclusive schema or error inside the "core" model file would be the same bounded-context leak the ADR exists to prevent, even without a literal import cycle — the test is not "is this ValidationError-shaped" (both sides are) but "who is the only caller." |
| `models/account.ts` | Same base `models/` rule, **plus** it may depend on `models/transaction.ts` (ADR-016 step 3: same aggregate-may-depend-on-core rule as `models/creditCard.ts` above) — `AddAccountMovementSchema`/`UpdateAccountTransactionSchema` `.extend` the core's minimal `CreateTransactionSchema`/`UpdateTransactionSchema` (ADR-019 step 1) with `account`, the one field this aggregate owns (card/bill vocabulary never reaches the core at all, so there's nothing left here to omit). `accountErrors.creditPostRejected` (raised only by the account aggregate, `controllers/account/transaction.ts`) already lived here before this split, consistent with the same rule. `CreateTransferSchema` moved here at ADR-016 step 4 (from `models/transaction.ts`, which never had a `createTransfer` entry point of its own) for the same reason: a transfer request is account-context vocabulary, even though `transfer.ts` persists it via the core's `TransactionType.enum.transfer` row shape. |
| `common/errors` | `models/` (composes `AppError` as the union of per-model error types; ADR-012) |
| `adapters/` | `models/`, `wire/*` |
| `diplomat/*` | `controllers/`, `adapters/`, `models/`, wire schemas, runtime clients |
| `diplomat/db/seed/` | `models/` (types and runtime enums) — nothing outside `diplomat/db` imports `seed/` |
| `diplomat/mcp` → `diplomat/http/{routes,openapi}.ts` | **Documented exception**: `buildRouteDefinitions`/`buildOpenApiDocument` are deterministic, no-business-logic wire-schema-driven builders (their only module-scope effect is a one-time, idempotent `extendZodWithOpenApi(z)` zod-prototype patch) reused verbatim by both the REST route and the `fintrack://openapi` MCP resource — including under stdio transport, which never touches Fastify — so the two surfaces can't drift (ADR-013 Phase A). |
| `controllers/transaction/{core,read,bulk}.ts` | **Narrower than `controllers/` above (ADR-016)**: same base rule, but additionally must NOT import `logic/bill.js`, `deps.bills`, or anything from `controllers/creditCard/*`/`controllers/account/*`/`models/creditCard.ts`/`models/account.ts` — not even a type-only import (enforced: `rg "logic/bill\|deps\.bills" src/controllers/transaction/` and `rg "creditCard|controllers/account" src/controllers/transaction/ src/models/transaction.ts` each match only the header comments that document this rule — no actual import or usage) — this is the shared transaction core (row integrity, category resolution, generic patch/delete primitives, cross-cutting reads) that aggregates depend on, never the reverse. `bulk.ts`'s `runStatementImport` (ADR-017 step 2) makes **no** ownership decision at all — unlike its predecessor `createTransactionsBulk` (which delegated the account-vs-card dispatch to a composition-root router), single-source statement imports fix ownership by construction: whichever aggregate importer (`importCardStatement`/`importAccountStatement`) called `runStatementImport` already knows which one card/account every line belongs to. `runStatementImport` only defaults per-line fields (date, idempotencyKey) shared by every import and calls the injected `StatementLineCreateFn` callback — typed purely against the core's own generic `StatementLine`/`ClassifiedUpsertResult`, with no card- or account-shaped field baked into the signature — once per line. |
| `controllers/creditCard/*` | Same base `controllers/` rule, **plus** it may depend on `controllers/transaction/{core,read,bulk}.ts` — the credit-card aggregate owns card CRUD (`creditCard.ts`), the bill lifecycle (`bill.ts`), and card-transaction policy (`transaction.ts`: `addCardPurchase`/`updateCardTransaction`/`deleteCardTransaction`/`importCardStatement`), validating (account-type ownership via its own `assertCreditAccountLeg`, built on `controllers/resolve.ts`'s neutral `resolveLegAccounts` — ADR-020; paid-bill immutability; cycle resolution) before delegating row persistence to the core. Never calls `guardTransferMutability` — the one transfer it ever sees (the bill-payment transfer) is blocked outright by its own bill-process guard, not transfer-immutability policy (ADR-020 §3). `importCardStatement` (ADR-017 step 2) binds `addCardPurchase` to the ONE card named in the request and delegates the generic import loop to `bulk.ts`'s `runStatementImport`. |
| `controllers/account/*` | Same base `controllers/` rule, **plus** it may depend on `controllers/transaction/{core,read,bulk}.ts` — the account aggregate owns account CRUD + balances (`account.ts`), account-movement policy (`transaction.ts`: `addAccountExpense`/`addAccountIncome`/`updateAccountTransaction`/`deleteAccountTransaction`/`importAccountStatement` — namespaced as `controllers/account/*` already, so the file doesn't repeat "account" in its own name), and transfers (`transfer.ts`: `createTransfer`, folded in from the former top-level `controllers/transfers.ts` at ADR-016 step 4 — a transfer request is account-context vocabulary even though it persists via the shared core primitive), validating (non-credit account, category/sub-category exclusivity, currency match, distinct legs) before delegating row persistence to the core. `updateAccountTransaction`/`deleteAccountTransaction` assert account-type ownership via their own `assertAccountOwnedLegs` (built on `resolveLegAccounts`, testing membership in `logic/account.ts`'s `isAccountOwnedType` — its own positive scope, not a negation of the credit-card aggregate's test, ADR-020) before delegating to the core's generic patch/delete; `updateAccountTransaction` additionally runs `guardTransferMutability` (`logic/account.ts`, ADR-020 §4) — the only place a regular, mutable transfer is ever reached. `importAccountStatement` (ADR-017 step 2) binds `addAccountExpense`/`addAccountIncome` (picked per item by the item's own `type`) to the ONE account named in the request and delegates the generic import loop to `bulk.ts`'s `runStatementImport`. |

### Boundary schemas and adapter naming

- External shapes belong to `src/wire/`, split by intent:
  - `wire/in`: inbound contracts from clients/resources (request payloads, tool args, events).
  - `wire/out`: outbound contracts exposed by this service (responses, published payloads).
  - `wire/db`: storage-facing contracts (db rows/records/properties).
- Domain layer (`controllers/`, `logic/`, `models/`) stays agnostic to wire schemas and infrastructure tools.

#### Domain ownership: descriptions, defaults, and error payloads

These three live with the domain entity in `models/`, not scattered across controllers/diplomats:

- **Descriptions are domain information.** `.describe()` states what a field *is and represents*, so it belongs on the domain schema in `models/`. The MCP/REST edge surfaces those same descriptions by deriving its input schema from the model (`Schema.shape`) instead of re-authoring prose.
- **Defaults split by intent.** A default that protects an **invariant** — a value that must exist for the entity to be valid ("would break if missing", e.g. `initialBalance → 0`) — lives on the **domain** schema. A **quality-of-life** default (a convenience when the caller omits an otherwise-required field, e.g. "no currency given → assume USD") lives at the **wire boundary** (`wire/in`, derived via `.extend`). The domain stays honest about what is genuinely required; not-null fields stay required in the model.
- **Expected-error payloads are domain vocabulary (ADR-012).** Each model defines its own error union (e.g. `AccountError`, `CategoryError`) and payload builders (e.g. `accountErrors.duplicateName(name)`), typed against shared primitives from `models/error.ts` — never against the composed `AppError`. `common/errors.ts` composes `AppError` as the union of all per-model error types and keeps the exhaustive `formatAppError`/`httpStatus` switches. Controllers *raise* errors via builders (`guard(condition, accountErrors.X)`) but never author the `{ code, … }` literal inline.
- **Guard conditions are named predicates, not inline boolean soup.** A pure condition is a predicate in `logic/` (e.g. `assertNonCreditType(type)`, `isUnreferenced(refs)`); a condition that needs a repo is a small async predicate in the controller (e.g. `assertNameAvailable(deps, name)`). The `guard` then reads as `guard(predicate(...), errorPayload)` — condition and payload each have a single home. Inline comparisons like `refs.transactions === 0` are the same smell as an inline error literal — extract them.
- **The shapes a decision is made from are domain types too.** When the domain decides whether to allow/block an operation based on some derived shape (e.g. `AccountReferences` = what counts as a blocking reference to an account), that shape is a `models/` type; the repo *populates* it and `logic/` predicates *interpret* it. The model — not the repo — declares what counts.
- Adapter functions should be grouped per domain and named by direction, for example:
  - `wireInToModel`
  - `modelToWireOut`
  - `modelToDb`
  - `dbToModel`
- In call sites, prefer namespace imports for clarity, e.g. `import * as transactionAdapters from '../adapters/transactions.js'` then `transactionAdapters.modelToDb(...)`.

## Write path: functional core / imperative shell (ADR-021)

**Current state:** every write flow is converted except **bulk statement import**, which still drives its own
persistence via injected repo write methods (`deps.transactions.create`); those write methods are removed once it
converts. Migration history lives in ADR-021/ADR-022, not here.

The shape, per `docs/functional-core-imperative-shell.md`: a controller **decides** and returns the write as data
instead of performing it; the diplomat shell **applies** it.

- **`Persistable` / `PersistOp`** (`src/models/persistable.ts`): **entity-agnostic.** `Persistable<Tag extends
  string = string, Model = unknown>` is generic over the entity's own tag + model rather than a closed union
  enumerating every entity — this file never imports a specific entity's model, and never needs editing as
  more flows are converted. `PersistOp` is a named enum (`insert`/`update`/`delete` — constants over literals)
  shared across every entity. Each entity module owns its own tag: `models/account.ts`'s
  `ACCOUNT_ENTITY_TAG = 'account'`. A converted controller returns
  `ResultAsync<{ persist: Persistable[]; response: T }, AppError>` instead of `ResultAsync<T, AppError>` —
  composed with `safeTry` exactly as before, it just stops calling `deps.<x>.create` and instead builds a
  `Persistable` from the model it already holds, via the generic builders in `logic/persistence.ts`
  (`insert`/`update`/`remove` — also entity-agnostic; one place every converted controller constructs the
  tagged shape from, and, being generic over `Tag`/`Model`, never needs a new case as more entities convert).
- **`version`**: every mutable entity table carries `version INTEGER NOT NULL DEFAULT 0` (see § Relational
  schema) — an optimistic-concurrency token, internal to the persistence side only, never exposed on the
  entity's public model/wire shape (`Account`/`AccountSchema`). It is **not** part of an `insert`
  `Persistable`'s model either: a brand-new row's version is always the same structural constant
  (`INITIAL_VERSION`, exported from `models/persistable.ts`) — nothing the core decides, so the core never
  states it, and the entity's own diplomat-edge adapter supplies it once, at the handler, right where it
  shapes the insert row (see below). Only `update`/`delete` carry a real, varying `version` (the value the
  core read), via the persistence-side type (`AccountEntity`/`AccountEntitySchema` in `models/account.ts`,
  `Account` + `version`). Because an insert's model is already the plain `Account`, a converted create flow's
  response is that same model — no stripping needed.
- **The model→row adaptation happens once, explicitly, at the diplomat handler — never inside `diplomat/db`.**
  A converted controller's `Persistable`s carry domain models (`Account`/`AccountEntity`); by the time
  `withUnitOfWork` applies them, they must already be db rows. The MCP/REST handler that calls `unitOfWork`
  does that conversion itself, mapping the controller's `FlowOutcome` through the entity's own `outcomeToDb`
  (`adapters/accounts.ts`, built from just `modelToDb` via `logic/persistence.ts`'s `entityDbAdapter` — see
  below) *before* handing the flow to `unitOfWork` — e.g.
  `createAccount(deps, model).map(accountAdapters.outcomeToDb)`. `unitOfWork(flow)` itself is still called
  with one argument, exactly as before; only what `flow` produces changed. This keeps `modelToDb` calls
  where the rest of the codebase already expects adapter calls to live — at the boundary, explicit at the
  call site — rather than hidden inside `diplomat/db`.
- **`entityDbAdapter`** (`src/logic/persistence.ts`) — the diplomat-edge counterpart to
  `versionedTableApplier` below, factored out for the same reason: every entity's `persistableToDb`/
  `outcomeToDb` pair followed the identical op-switch shape by hand (no-op on a foreign entity tag;
  `insert` bakes in `INITIAL_VERSION` before shaping the row; `update` shapes the already-versioned model;
  `delete` carries no model to shape). `entityDbAdapter(entityTag, modelToDb)` builds that pair from just
  the entity's own `modelToDb`, so an adapter module (`adapters/accounts.ts`, `adapters/categories.ts`, …)
  supplies `modelToDb` and one line —
  `export const { persistableToDb, outcomeToDb } = entityDbAdapter(ACCOUNT_ENTITY_TAG, modelToDb)` — instead
  of hand-writing the switch. An entity whose domain model already matches its row shape 1:1 once versioned
  (`tags`) still supplies a `modelToDb` — the identity function — rather than skipping the factory, so
  every entity's adapter follows the same one-line shape. Not every entity fits: `adapters/bills.ts` calls
  `modelToDb` the same way for `insert` and `update`, but a bill's `update` genuinely needs
  `paymentTransactionId: undefined` (leave the column unchanged) to mean something different from `null`
  (clear it) — the uniform factory can't express that asymmetry, so `bills` keeps its own hand-written
  `persistableToDb`/`outcomeToDb`, unchanged by this factory.
- **`EntityApplier` / `ApplierRegistry`** (`src/diplomat/db/unitOfWork.ts`): **entity-agnostic** — the generic
  engine dispatches an already row-shaped `Persistable` to `registry[p.entity]` and calls that applier's
  `insert`/`update`/`delete`; it never names a specific entity, never imports a specific entity's `modelToDb`
  adapter or drizzle table, and — critically — never needs a new `case` as more entities convert. The
  `ApplierRegistry` (`Record<string, EntityApplier>`) is assembled once, at the composition root (`main.ts`,
  `test/integration/app-builder.ts`), from each entity's applier keyed by its own tag constant, and bound into
  the `UnitOfWork` closure alongside `Db`.
- **`versionedTableApplier`** (`src/diplomat/db/unitOfWork.ts`): once the model→row adaptation moved to the
  handler (above), an `EntityApplier`'s `insert`/`update`/`delete` became pure mechanics — cast the row, run
  `... SET ..., version = <read version + 1> WHERE id = ? AND version = ?` (the new version computed in
  application code from the row's own `version` field — never a SQL-side `version + 1` expression; same rule
  as `withUnitOfWork` below) — identical for any table keyed by an `id` column with a `version` column, which
  is 8 of the 9 mutable tables (`dashboards` keys on `name` instead). Rather than hand-write that per entity,
  `versionedTableApplier(table)` builds a complete `EntityApplier` from just the drizzle table reference —
  `diplomat/db/repos/accounts.ts`'s `accountApplier` is `versionedTableApplier(accounts)`, a one-liner. An
  entity whose table doesn't fit the convention (e.g. `dashboards`) still hand-writes its own `EntityApplier`
  against this same interface — `diplomat/db/repos/transactions.ts`'s `transactionApplier` (phase 2a) is the
  first example: a transaction row's storage shape has genuine extra mechanics beyond `id`/`version`
  (`insert` conflicts on `idempotency_key`, not `id`; both `insert`/`update` upsert the referenced merchant and
  attach/replace `transaction_tags`) — still persistence structure, not business logic, just too much for the
  generic factory to cover.
- **`versionedTableApplier`'s `delete` — a foreign-key violation is the same race a stale version reports, just
  caught later**: a flow that emits a version-guarded `delete` (e.g. `deleteCreditCard`) decided what else needs
  removing from a point-in-time read; if some other row starts referencing the one being deleted after that read
  but before the batch applies (a concurrent write lands in the gap — e.g. a new `add_card_purchase` on the card
  a `delete_credit_card` is mid-flight on), the FK check on the `delete` itself fails. `versionedTableApplier`
  recognizes that one violation (`LibsqlError.extendedCode === 'SQLITE_CONSTRAINT_FOREIGNKEY'`, via
  `diplomat/db/sqliteErrors.ts`'s `isForeignKeyConstraintViolation` — the same `.cause`-chain walk
  `isUniqueConstraintViolation` below uses) and rethrows it as `VersionConflict`, rolling back and re-invoking the
  flow (rule 4) instead of surfacing a raw throw: a fresh read now sees the new row and folds it into the cascade.
  Applies to every entity built from the factory, not just credit cards — any versioned delete can hit this same
  race.
- **`billApplier` — a genuine non-`id` uniqueness conflict on insert, surfaced as a retry, not swallowed**
  (`diplomat/db/repos/bills.ts`, phase 2b): `bills` fits the `id`/`version` convention for `update`/`delete`
  (built from `versionedTableApplier` directly), but a bill is *created* by upsert-by-cycle
  (`UNIQUE(creditCardId, month, year)`), not by `id` — `add_card_purchase` mints a speculative id for what it
  believes is a brand-new cycle, and a concurrent first purchase on the same cycle can race it (two inserts,
  different ids, same cycle). `versionedTableApplier`'s own `onConflictDoNothing` is scoped to the `id` target
  only, so it does not swallow that race; SQLite raises a genuine unique-constraint error instead. `billApplier`
  recognizes exactly that one violation (via `LibsqlError.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'` — a
  bill's `id` collision never reaches this point, since `onConflictDoNothing` already absorbs it, so any other
  unique-constraint violation on a bill insert can only be this one) and rethrows
  it as `withUnitOfWork`'s own `VersionConflict` — exported from `diplomat/db/unitOfWork.ts` for exactly this
  case — rolling back the whole batch and re-invoking the flow (rule 4): a fresh read of `findByCycle` now sees
  the winner's row, and the domain emits a version-guarded *touch* of it instead of a second insert. Any other
  error still propagates unchanged. This is the only entity whose `insert` needs anything beyond the generic
  mechanics — `update`/`delete` are plain `versionedTableApplier`.
- **`PersistOutcome` and idempotency-aware responses** (`models/persistable.ts`, rule 6): the shell reports back
  what actually happened when it applied each `Persistable` — chiefly, for `insert`, whether the row actually
  landed (`applied`) or was skipped as an idempotent duplicate, plus the entity's own already-decoded `read` of
  what is now actually persisted (e.g. the existing row on a duplicate). A `FlowOutcome.response` is normally
  just the plain, core-derived value; an idempotency-aware flow instead hands back a **pure, sync** function of
  the batch's `PersistOutcome[]`, which `withUnitOfWork` calls once applied — `response` stays data-shaping
  only, deliberately never a place a flow performs I/O of its own (rule 1). `add_account_expense`/
  `add_account_income`/`create_transfer`'s `created` flag is the first user; this is the mechanism bulk import
  (phase 3) reuses for its own per-item created/duplicate outcomes. A flow that needs a *further* write (e.g.
  `update_account_transaction`'s merchant-learning off a category correction) puts that write in `persist` too
  — composed into the same atomic batch (rule 5) via its own minimal entity
  (`models/merchant.ts`'s `MERCHANT_CATEGORY_ENTITY_TAG` / `diplomat/db/repos/merchants.ts`'s
  `merchantCategoryApplier`) — rather than reaching for a side effect in `response`. Because `response` is pure
  (a function of `PersistOutcome[]` plus whatever plain values the flow closes over — `locale`, `classification`),
  the mechanical part — cast `PersistOutcome.read` back to `RawTransactionView`, localize it — lives in
  `logic/transaction.ts` as named, independently unit-tested functions: `viewFromOutcome` builds a bare
  `TransactionView` from one outcome (the model — no `created`/`classification` envelope), and `buildUpsertResult`
  builds `models/transaction.ts`'s `UpsertTransactionResult` (`{ transaction, created, classification? }` — the
  one result shape every insert-shaped flow returns: `create_transfer` uses it with `classification: undefined`,
  `add_account_expense`/`add_account_income` with a real one — `ClassifiedUpsertResult` names the
  classification-required narrowing those two actually return). `update_account_transaction` uses
  `buildTransactionView` (`viewFromOutcome` composed with `firstOutcome` — its own entity leads the batch).
  `add_card_purchase`/`update_card_transaction` (phase 2b) instead compose `viewFromOutcome` with
  `logic/persistence.ts`'s `lastOutcome`: a card-purchase/reassignment batch's bill `Persistable`(s) must apply
  *before* the transaction one (the transaction row's own `bill_id` FK must reference a row that already exists
  when it's a fresh bill insert), so the flow's own entity trails the batch instead of leading it — `firstOutcome`
  would resolve the wrong outcome there. Naming
  deliberately avoids "response" — these build/format a model, not an HTTP/MCP response; a further envelope
  around the shell's outcome is genuine *controller* orchestration when one is needed, not something to push
  into `logic/` or an adapter (an adapter can't do it: `created` only exists inside the `PersistOutcome` the
  flow's own `response` closure sees, never after `unitOfWork` resolves, which is the only point an adapter
  could run). Each of these is `purry`'d (data-last curried on the non-`outcomes` args — `docs/code-quality.md`'s
  dual-calling convention, same as `addLocalizedLabels`), so e.g. `buildUpsertResult(classification, locale)`
  **is** the `(outcomes) => T` function `FlowOutcome.response` wants — every converted flow assigns it directly,
  no wrapping arrow at any call site.
- **`payBill`/`revertBillPayment` (phase 2c, `controllers/creditCard/bill.ts`) — a plain (non-idempotency-aware)
  `response`, and an FK direction that reverses the batch order between the two flows.** Unlike phase 2b's
  card-purchase flows, neither bill flow needs `PersistOutcome`-derived response shaping: both mint every id and
  read every field the response needs *before* the batch is built (a fresh `newId()` transfer id for `payBill`,
  the already-read `RawBill` for both), so `response` is the plain value `buildPaidBillWrite`/
  `buildClosedBillWrite` return alongside the `Persistable`, not a function of the outcomes. Batch order is FK-
  direction-driven, and the two flows go opposite ways: `payBill`'s positive-total batch is `[transfer insert,
  bill update]` — the transfer must exist before the bill update that points `payment_transaction_id` at it;
  `revertBillPayment`'s batch is `[bill update, transfer remove]` — the reverse — since `bills
  .payment_transaction_id` (no `ON DELETE` action) must be cleared before the transfer row it references can be
  deleted, and libsql enforces foreign keys by default. `BillEntity.paymentTransactionId` therefore distinguishes
  `undefined` (leave the column unchanged — drizzle's `.set()` drops `undefined`-valued keys) from `null`
  (explicitly clear it, `revertBillPayment`'s own case) — the same convention `TransactionsRepo.update`'s
  `subCategoryId` already established. `revertBillPayment`'s `tryFindPaymentTransaction` returns `null` both when
  the bill never had a payment transfer and when `paymentTransactionId` no longer resolves (e.g. a concurrent
  `delete_credit_card` removed it in the window between `revertBillPayment`'s own un-batched reads — that flow is
  still repo-driven, not yet on ADR-021's version-guarded shell); either way the batch just carries the bill
  update alone, nothing to delete. If the bill itself was also concurrently deleted, that update's own version
  guard fails at apply time and the shell's retry resolves it to a clean `unknown_bill` instead of a 500 — no
  throw needed for what would otherwise be a legitimate, if narrow, race. `BillsRepo` exposes
  no write methods — only reads (e.g. `findById`) plus the still-repo-driven `ensureOpen`, which bulk import
  uses until it converts.
- **Phase 3a — the simple entity CRUD flows, including two entity-agnostic cascade appliers and a two-entity
  batch pattern.** `update_account`/`delete_account` needed no new applier (`accountApplier` already existed,
  phase 1) — just a version-carrying read (`accountsRepo.findRawById`) the flows didn't have before. Three new
  entities converted, each owning its own tag (`models/tag.ts`'s `TAG_ENTITY_TAG`, `models/category.ts`'s
  `CATEGORY_ENTITY_TAG`, `models/creditCard.ts`'s `CREDIT_CARD_ENTITY_TAG`):
  - **`tagApplier`** (`diplomat/db/repos/tags.ts`) mirrors `billApplier`'s pattern exactly: `tags.name` carries
    its own `UNIQUE` constraint the domain's own pre-check (`assertTagNameAvailable`) only guards the common
    case, so a concurrent same-name create can raise a genuine non-`id` unique-constraint violation
    `versionedTableApplier`'s `onConflictDoNothing` (scoped to `id`) doesn't swallow; `tagApplier` recognizes it
    and rethrows as `VersionConflict`, rolling back and retrying — on retry the domain's own name check now sees
    the committed row and returns `duplicate_name` instead of a raw 500. The shared cause-chain-walking check
    (`LibsqlError.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'`) moved out of `bills.ts` into
    `diplomat/db/sqliteErrors.ts`'s `isUniqueConstraintViolation`, so both appliers share one implementation.
    `deleteTag` is by id (no name resolution) and stays idempotent-by-design: a missing id returns
    `{ deleted: false }` on an *empty* `persist` batch (no write) rather than an error — unchanged pre-ADR-021
    behavior (mirrors `deleteAccountTransaction`'s dry-run shape).
  - **`categoryApplier`** (`diplomat/db/repos/categories.ts`) is shared by both a top-level category and a
    sub-category — same `categories` table, `parentId` set or not, one `CATEGORY_ENTITY_TAG` — and is plain
    `versionedTableApplier(categories)`, no mechanics beyond the ordinary convention. It once purged dependent
    `merchant_category` rows itself before the row delete (`merchant_category.category_id` has no `ON DELETE`
    action, so a plain delete would otherwise violate the FK while a learned association still pointed at the
    category) — the repo hand-implementing a referential-integrity mechanic that belongs to the schema, the same
    layering slip `creditCardApplier` (below) had. Unlike that case, this cleanup is *pure mechanics* with zero
    decision in it — no reads, no branching, always the identical unconditional cascade whenever a category
    disappears (the domain's own `isCategoryUnreferenced` guard already deliberately leaves merchant learning
    out of what *blocks* a delete — deleting a category is meant to also clear its learned classifications,
    re-learnable later — so there was never a decision for the domain to make here). That makes it structurally
    identical to `transaction_tags.transaction_id`'s `ON DELETE CASCADE` — an association row with no
    independent meaning once its owner is gone — so it now lives there too:
    `merchant_category.category_id` references `categories.id` with `{ onDelete: 'cascade' }`
    (migration `drizzle/0010_category_merchant_association_cascade.sql`).
  - **`creditCardApplier`** (`diplomat/db/repos/creditCards.ts`) is plain `versionedTableApplier(creditCards)` —
    no cascade of its own. An earlier version of this applier read the card's own `accountId` back and
    cascade-deleted every correlated bill/transaction/tag itself, mirroring the pre-ADR-021 `deleteCard` repo
    method's own cascade. That was the repo deciding a business question — "what happens when a card is
    deleted" (hard-delete vs. a future soft-delete/archive is exactly the kind of call that should be able to
    change without touching the persistence layer) — the ADR-015/018 smell ADR-021 exists to remove, recurring
    one layer down; fixed before shipping. **The cascade decision now lives in the domain.**
    `deleteCreditCard` (`controllers/creditCard/creditCard.ts`) reads every bill (`billsRepo.findAllByCard`) and
    transaction (`transactionsRepo.findAllCorrelatedToCard`) correlated to the card and emits their own
    `update`/`delete` `Persistable`s explicitly. "Correlated to a card" (a purchase on it, or any movement on its
    own internal liability account) is itself one predicate, `diplomat/db/repos/transactions.ts`'s
    `correlatedToCard` — exported from the transactions repo since every column it reads
    (`credit_card_id`, `from_account_id`, `to_account_id`) is a transactions-table column, and reused by
    `creditCardsRepo.countCorrelated`'s dry-run counts, so the definition lives in one place rather than
    two copies of the same SQL. In
    FK-safe order: a bill with a payment transfer has a
    **circular reference** with it (`bills.payment_transaction_id` → the transfer; the transfer's own `bill_id`
    → the bill; libsql enforces foreign keys, no `ON DELETE` action on either column) — that one reference is
    cleared first (`update`, `paymentTransactionId: null`), then every correlated transaction is removed
    (`transaction_tags` cascades via its own `ON DELETE CASCADE` — a genuine DB mechanic declared in the schema,
    not a business decision, so it stays outside the `Persistable` batch entirely), then every bill, then the
    card, then its internal liability account. A bill this batch already cleared is removed at the version the
    shell will have bumped it to by the time that delete applies in the same transaction (`bill.version + 1` —
    computed by the domain from the same deterministic rule the shell itself uses, rule 4) — carrying the
    version read at decision-time would target a row the update already moved past, a false version conflict.
    `deleteCreditCard`'s batch is therefore variable-length: `[...bill-clears, ...transaction removals, ...bill
    removals, remove creditCard, remove account]` — a genuine multi-entity composition (rule 5), not the
    two-entity batch an earlier version of this flow got away with by pushing the correlated-row cleanup into
    the applier. `createCreditCard` stays a **two-entity insert batch** — `[insert account, insert creditCard]`,
    account first since the card row's `accountId` is a `NOT NULL` FK into it.
  - MCP/REST handlers compose the entity's own `outcomeToDb` per batch member, same as `add_card_purchase`'s
    bill+transaction pattern: `create_credit_card` maps through `accountAdapters.outcomeToDb` and
    `creditCardAdapters.outcomeToDb`; `delete_credit_card`'s larger batch maps through all four —
    `creditCardAdapters`, `accountAdapters`, `billAdapters`, and `adapters/transactions.ts`'s `outcomeToDb`.
- **Phase 3b — the recurring flows.** `create_recurring` needed a new entity (`models/recurring.ts`'s
  `RECURRING_ENTITY_TAG`, `RecurringRuleEntitySchema` carrying `version`, kept off the wire-facing
  `RecurringRuleSchema`/`RecurringRuleViewSchema` the same way `AccountEntitySchema` stays off `AccountSchema`)
  and a new `recurringRuleApplier` — plain `versionedTableApplier(recurringRules)`, no mechanics beyond the
  ordinary convention (the row shape already matches the table 1:1). `createRecurring` is a one-entity insert
  batch, response built from the already-resolved account/category (rule 6, no read-back). `applyDueRecurring`
  is the meatier conversion: it reads every due rule (`recurringRepo.due`, now version-carrying), computes each
  rule's occurrences (bounded at `MAX_RECURRING_OCCURRENCES_PER_RUN` = 36) and its advanced `nextDue` in the
  domain, and emits **one merged batch for every due rule** — every occurrence as a `TRANSACTION_ENTITY_TAG`
  insert (via the same `transactionApplier` phase 2a introduced) followed by every rule's own version-guarded
  `RECURRING_ENTITY_TAG` update (`advance`) — applied atomically. This is a deliberate atomicity-granularity
  choice: the pre-ADR-021 code advanced each rule independently (a failure partway through could leave some
  rules advanced and others not); the FC/IS version retries the *whole* run on any version conflict, which is
  safe because `recurringIdempotencyKey`'s `rec-<ruleId>-<date>` keys make re-materialization a no-op — an
  already-created occurrence is never duplicated by a retry. `ApplyDueResult`'s `applied`/`count` are shaped
  from the shell's per-insert outcomes (the same idempotency-outcome contract as phase 2a, `viewFromOutcome`) —
  never inferred by the domain. `recurringRepo.create`/`.advance` had no remaining caller once both flows
  converted — grep-confirmed zero callers (production or test) — and were removed in this same change, the same
  checked-and-removed precedent phase 3a set for its five entities. `deps.transactions.create` stays: bulk
  import (phase 3c) still needs it.
- **Merchant key is always stored, matched or not** (`controllers/account/transaction.ts`'s `planAccountMovement`):
  `pickClassification` (`logic/classify.ts`) only returns a `merchantKey` when it found a match, since a matched
  key is the (possibly partial) `merchant_category` key substring-matched against, not the transaction's own
  description — reusing it keeps a later correction reinforcing that same generalized key rather than
  fragmenting it. On no match there is nothing to reuse, but the transaction still needs *some* merchant key
  stored on its row, or a later category correction (`resolveMerchantCorrection`) has nothing to attach to — it
  can only ever strengthen a merchant the transaction is already linked to. `planAccountMovement` falls back to
  the full `normalizeMerchant(description)` in that case (empty-string guarded, since that can't back a
  `merchants` FK row). This closes a real gap: before this fallback existed (true on `main` too, not introduced
  by this phase), a brand-new merchant's first correction was silently dropped — `merchant_key` stayed `null` on
  the row, so `resolveMerchantCorrection`/the old `strengthenFromTransaction` had nothing to key off. The
  identical gap still exists in `add_card_purchase` (its own `planCardPurchase` uses
  `classification.merchantKey` as-is, with no fallback) — the FC/IS conversion (phase 2b) deliberately left this
  behavior unchanged; tracked as [#115](https://github.com/RafaelFCarneiro/fintrack/issues/115).
- **`withUnitOfWork`** (`src/diplomat/db/unitOfWork.ts`, `diplomat/db` — the only place that touches `Db` for a
  converted flow): `withUnitOfWork(db, registry, flow)` invokes `flow`, applies the returned `persist` batch in
  one `db.transaction` by dispatching each already row-shaped `Persistable` through the `registry` (insert
  honors `onConflictDoNothing`, left to each applier's own discretion; `update`/`delete` apply
  `... SET ..., version = <read version + 1> WHERE id = ? AND version = ?`, with the new version computed in
  application code from the row's `version` — never an opaque `version + 1` SQL expression the database
  evaluates on its own), and returns `flow`'s `response`. A version-guarded op that affects zero rows rolls
  back the whole batch and re-invokes `flow` — a fresh read, a fresh decision — up to a bounded number of
  attempts, then surfaces the generic `conflict` `AppError` (`models/error.ts`; no business payload by design).
- **Wiring**: `controllers/deps.ts` exports the `UnitOfWork` function type (`(flow) => ResultAsync<T, AppError>`)
  — the shape the shell's edges depend on — but it is **not** a field on `Deps`; `Deps` is handed to
  controllers, and a `UnitOfWork` runner is shell-only (only `diplomat/mcp`/`diplomat/http` handlers call it,
  wrapping a controller invocation), so a controller can never reach for it and apply its own writes.
  `main.ts` (and `test/integration/app-builder.ts`) construct the one `UnitOfWork` bound to the real `Db` and
  the `ApplierRegistry`, and thread it alongside `deps` through `connectStdio`/`buildMcpServer`/
  `buildHttpApp`/`registerRoutes`/`registerMcpRoute` to the handlers that call a converted controller.

## Relational schema (as built)

Database: encrypted libSQL file (`fintrack.db`) opened via `@libsql/client` (async) with `drizzle-orm/libsql`. Schema defined in `src/diplomat/db/schema.ts`; migrations generated by `drizzle-kit` and applied at startup via `migrate()`. Key `from @napi-rs/keyring` (ADR-005); `FINTRACK_DB_KEY` env var overrides for CI/headless.

Every mutable entity table below also carries `version INTEGER NOT NULL DEFAULT 0` (not shown per-line) —
the optimistic-concurrency token for the generic versioned unit of work (ADR-021 § Write path below).
`currencies`, `merchants`, `merchant_category`, and `transaction_tags` do not — they are reference/join tables,
not aggregates a flow returns as a `Persistable`.

```
currencies          (code PK, symbol, name)
accounts            (id PK, name, type: checking|savings|wallet|investment|credit,
                     initial_balance, currency FK→currencies, version)
credit_cards        (id PK, name, currency FK, closing_day, due_day, limit_amount?,
                     account_id FK→accounts, payment_account_id FK→accounts, version)
categories          (id PK, name, kind: expense|income|both, parent_id FK→self, names JSON?, version)
merchants           (key PK)
merchant_category   (merchant_key FK, category_id FK — composite PK; weight, origin: rule|history)
tags                (id PK, name UNIQUE, version)
bills               (id PK, credit_card_id FK, month, year, close_date, due_date,
                     status: open|closed|paid, payment_transaction_id FK→transactions?, version —
                     UNIQUE(credit_card_id, month, year))
transactions        (id PK, description, amount, type: expense|income|transfer,
                     status: pending|effective DEFAULT effective,
                     date, currency, source: mcp|rest|import, idempotency_key UNIQUE,
                     classification_method, confidence, raw_input?, note?,
                     from_account_id FK, to_account_id FK,   ← transfer uses both (ADR-002)
                     credit_card_id FK, bill_id FK, category_id FK, subcategory_id FK,
                     merchant_key FK, version,
                     INDEX: (status, date) — supports scheduling queries)
transaction_tags    (transaction_id FK, tag_id FK — composite PK)
recurring_rules     (id PK, description, amount, type, period, next_due, currency,
                     account_id FK, category_id FK, version)

settings            (id PK DEFAULT 'singleton', locale: en|es|pt DEFAULT en,
                     locale_source: default|inferred|explicit DEFAULT default, version)
dashboards          (name PK, html, updated_at, version — ADR-013 Phase A; see § Dashboards / `/ui` surface)

transactions_fts    VIRTUAL TABLE fts5(description, content='transactions')
                    — kept in sync via INSERT/UPDATE/DELETE triggers
```

Repos live in `src/diplomat/db/repos/`; each accepts a `Db` (`LibSQLDatabase<typeof schema>`) injected from `main.ts`. Drizzle query builder is used for simple CRUD; `db.all(sql\`...\`)` for joins and FTS5 searches. All queries parameterized — never string-interpolate user input.

Seed data (currencies, categories, merchant rules) lives in `src/diplomat/db/seed/` (ADR-008). Seed-only types (`DefaultCategoryId`, `MerchantRule`) live there too — the domain never imports seed.

## Invariants (violations are bugs)

1. **Idempotency**: every Transaction write uses `UNIQUE(idempotency_key)` + `onConflictDoNothing()`; `rowsAffected === 0` means duplicate — return the existing row, `created: false`.
2. **Transfers** are `type: 'transfer'` with both `from_account_id` AND `to_account_id` set (ADR-002); summary/classification queries MUST exclude them (`t.type != 'transfer'`).
3. **Currency**: transactions denormalize the account/card currency at write time; aggregations group per currency, never convert.
4. **Balances are derived**, never stored: `initialBalance + income − expenses + transfers in − transfers out`. **Only `effective` transactions count** — pending transactions never affect the current balance. Projection (balance + pending-through-date) is opt-in via `projectedAsOf` on `get_account_balances`.
   - **Effective-only invariant (Feature Design 001)**: `get_account_balances` and `get_spending_summary` MUST filter `status = 'effective'`. Projection queries explicitly include `pending`. Classification ignores status. This is enforced in `diplomat/db/repos/` — violations are bugs.
5. **Classification via merchant_category**: normalized description → `merchants.key` → strongest `merchant_category` edge; user corrections increment `weight` (`onConflictDoUpdate`).
6. **Category kind must match transaction type**: `expense` transactions may only use `expense` or `both` categories;
   `income` may only use `income` or `both`. Enforced in `controllers/transaction/core.ts`'s `resolveCategory`/
   `resolveSubCategory` (shared by every movement path) via `isCategoryKindAllowed` (predicate in `logic/transaction.ts`).
7. **Sub-category always paired with parent**: `subcategory_id` set → `category_id` must also be set to the sub-category's parent. Enforced by a `CHECK` constraint and in `controllers/resolve.ts`.
8. **Card purchases are funded by the card's internal liability account (debt).** Bill payment is a canonical transfer (ADR-002) from a bank account to the card account, excluded from spending summaries — never an expense (double-count). `pay_bill` creates it, links it via `bills.payment_transaction_id`, and marks the bill paid. Value enters a `credit` account only via `pay_bill`. **A `paid` bill has at most one payment transfer** (Feature Design 011): created only by `pay_bill`, removed only by `revert_bill_payment` (which deletes the transfer and flips `paid → closed` — the exact inverse; both are idempotent no-ops outside that transition). A bill marked paid with a non-positive total has no transfer (`payment_transaction_id` absent) — revert still flips it to `closed`. **A `paid` bill is composition-immutable** (Feature Design 012): `add_card_purchase` rejects landing a transaction on a `paid` bill (whether by explicit `billMonth`/`billYear` or plain cycle auto-assignment), `update_card_transaction` rejects moving a transaction off a bill that is currently `paid` (and rejects editing the bill-payment transfer itself outright — ADR-017), and `delete_card_transaction` rejects any transaction whose `bill_id` points at a `paid` bill — not just the payment transfer (which is itself always covered, since its own `bill_id` is the bill it paid, even though the transfer itself has no `credit_card_id`; ADR-017's union ownership rule — `cardId` **or** `billId` — routes the payment transfer to `update_card_transaction`/`delete_card_transaction` by construction, not by a composition-root lookup). Every case points the caller at `revert_bill_payment`; none of these guards ever auto-revert. `transactions.bill_id` is assigned automatically by cycle (`billPeriodFor`) or, when given, by an explicit `billMonth`/`billYear` (`billPeriodForCycle`) — either way it is set on the transaction row **at insert/update time itself** (ADR-021 phase 2b: `controllers/creditCard/transaction.ts`'s `resolveBillWrite` decides insert-a-fresh-`open`-bill vs. version-guarded-touch-the-existing-one as a `Persistable`, applied atomically with the transaction write by the shell; there is no separate "attach" step and so no orphan row to self-heal) — and is readable on `TransactionView` as `billId`. A transaction can only ever belong to a bill of its own card (structural: there is no way to change a transaction's card via `update_card_transaction`). All of this policy lives in the credit-card aggregate (`controllers/creditCard/transaction.ts`), never in the transaction core (ADR-016).
9. **Encryption on by default**: the database is always opened with an encryption key (from keychain or `FINTRACK_DB_KEY`). Opening without a key is a startup error. The key is never logged or committed (ADR-005).
10. Decode at the boundary: every external input and SQL row is zod-parsed before entering the domain.
11. **Dynamic query structure is composed only from whitelisted enum-keyed SQL fragments** (ADR-011); caller-supplied values are always parameter-bound; caller text is never concatenated into SQL. Exhaustive `Record<Enum, Fragment>` maps in `diplomat/db` are the only source of structural SQL; `assertNever` / TS exhaustiveness guards unmapped keys at compile time.
12. Behavior changes require tests: domain and boundary behavior updates must include unit tests in the same change (success and expected-failure paths).
13. **Category identity is the slug/id, not the localized name** (Feature Design 002, ADR-009). Default categories carry a JSON `names` column (`{"pt":"…","es":"…"}`); display name is resolved at read time as `names?.[locale] ?? name`. Merchant rules and classification key on the slug, never the display name. User-created categories have `names = null` and keep their literal `name`.
14. **Locale is AI-determined, stored, env-overridable** (Feature Design 002). `settings.locale` (`en|es|pt`), default `en`. Resolution: `FINTRACK_LOCALE` env → `settings.locale` → `'en'`. `set_locale` with `source: inferred` is rejected when `locale_source` is `explicit`.
15. **Seed is isolated (ADR-008).** Seed data lives in `diplomat/db/seed/`; the domain (`models/`, `logic/`, `controllers/`) never imports it. The app boots and works on an empty (unseeded) DB.
16. **Unbounded collections page by keyset cursor with the paginated envelope (ADR-014).** `search_transactions` (first mover) returns `{ items, nextCursor?, total? }`; `ORDER BY` is composed only from a whitelisted enum-keyed column map (`ORDER_BY_COLUMN` in `wire/db/transactions.ts`, turned into SQL only in `diplomat/db/repos/transactions.ts`), the same mechanism as invariant 11 applied to ordering — caller text never reaches `ORDER BY`. Cursors are opaque, zod-validated at the boundary, and bound to the `sort`/`dir` that produced them (a mismatch is a `validation` error). `total` is opt-in (`includeTotal`) — an extra same-WHERE `COUNT(*)`, never paid by sequential "walk until no `nextCursor`" consumers. Small, cycle-bounded `list_*` endpoints stay plain arrays; the envelope is the signal a collection can page.
17. **No god write flows for any transaction mutation (ADR-017, complete; ownership mechanism revised by ADR-020).** The only cross-cutting transaction surface is the read side (`search_transactions`, `get_spending_summary`, `aggregate_spending`, account balances); every write is an aggregate-specific entry point that validates ownership itself and never dispatches by inspection — there is no composition-root router. Update/delete: `update_card_transaction`/`delete_card_transaction`, `update_account_transaction`/`delete_account_transaction`. **Ownership is resolved by account type, not by a core structural discriminator (ADR-020), and each aggregate asks its own question rather than sharing one judgment:** `controllers/resolve.ts`'s `resolveLegAccounts` is a neutral I/O helper (resolves the accounts referenced by a transaction's leg(s) — `accountId`/`toAccountId` — via `deps.accounts.findById`; makes no ownership judgment of its own). The credit-card aggregate's own `assertCreditAccountLeg` (`controllers/creditCard/transaction.ts`) asks "is a leg `credit`" (ADR-010) — true for a card purchase (`accountId` **is** the card's own internal account) and the bill-payment transfer (`toAccountId` **is** that same account). The account aggregate's own `assertAccountOwnedLegs` (`controllers/account/transaction.ts`) asks the different, positive question "is every leg one of *my* types" against `logic/account.ts`'s `isAccountOwnedType` (an enumeration of `checking`/`savings`/`wallet`/`investment` — the account domain's own scope, not the negation of `credit`; vacuously true for an unattached movement with no legs at all). Neither aggregate reuses or negates the other's predicate, and the core owns no ownership discriminator at all. A wrong-tool call is rejected with a `validation` error naming the correct tool (`transactionErrors.wrongTool`, raised by each aggregate's own guard) — a guard, not a redirect the server performs on the caller's behalf. Card purchases and the bill-payment transfer are card-owned; regular movements and transfers are account-owned. Transfer *mutation* policy (`guardTransferMutability`, the `transferTypeImmutable`/`transferCategoryRejected` errors) lives wholly in the account context (`logic/account.ts`, `models/account.ts`) — the credit-card aggregate never reasons about transfer invariants; its one transfer (the bill-payment transfer) is blocked outright by its own bill-process guard — a `validation` error naming `revert_bill_payment` — not by transfer-immutability. Bulk: `import_card_statement`/`import_account_statement` are single-source — a statement belongs wholly to the ONE card/account the caller named, so there is no per-line owner to decide; the shared `controllers/transaction/bulk.ts` runner (`runStatementImport`) only defaults per-line fields and makes no ownership decision.
18. **The transaction core's movement schema is minimal (ADR-019 step 1).** `CreateTransactionSchema`/`UpdateTransactionSchema` (`models/transaction.ts`) carry only genuinely-shared ledger vocabulary (description, amount, type, status, date, category/subCategory, currency, idempotencyKey, rawInput, note, tags) — they name no sibling context's field. Each aggregate `.extend`s the core up with its own vocabulary rather than the core carrying the union for aggregates to `.omit` down: `AddCardPurchaseSchema` (`models/creditCard.ts`) adds `card`/`billMonth`/`billYear`; `UpdateCardTransactionSchema` adds `billMonth`/`billYear` (bill reassignment — no `card` field, since a transaction's card can't change on update); `AddAccountMovementSchema`/`UpdateAccountTransactionSchema` (`models/account.ts`) add `account`. The field-tied bill errors (`billPeriodIncomplete`, `billAssignmentRequiresCard`) moved with the fields to `cardErrors`. One documented exception: `UpdateCardTransactionSchema` also `.extend`s `account` (rather than leaving it out) purely so `controllers/creditCard/transaction.ts`'s `updateCardTransaction` can keep rejecting it with its dedicated `cardErrors.accountChangeRejectedForCard` message — omitting the field would replace that message with a generic `.strict()` unrecognized-key error, a worse-not-better outcome. Transfer is the boundary case: the transfer *row kind* (`TransactionType.enum.transfer`, balance/summary math, `TransactionView.toAccountId`) stays core because the shared read/balance side is structurally defined over it (`resolveEffectiveType` stays in `logic/transaction.ts`); transfer *policy* (`guardTransferMutability`, the `transferTypeImmutable`/`transferCategoryRejected` errors) lives in the account context (ADR-020). Currency resolution lives in `logic/money.ts` (context-neutral: a `{ currency } | null` funding source plus the input override); `assertBillPeriodPaired`/`withBillId` live in `logic/bill.ts` (credit-card context).
19. **A converted write flow returns its writes as data; it never performs them (ADR-021, phases 1–3b:
    `createAccount`, the account-context transaction flows, the credit-card transaction flows
    `add_card_purchase`/`update_card_transaction`/`delete_card_transaction`, the bill flows
    `pay_bill`/`revert_bill_payment`, the simple entity CRUD flows `update_account`/`delete_account`,
    `create_tag`/`delete_tag`, `create_category`/`delete_category`/`create_sub_category`/`delete_sub_category`,
    `create_credit_card`/`delete_credit_card`, and the recurring flows `create_recurring`/
    `apply_due_recurring`).** See § Write path above. A
    converted controller's `deps` never receives a write method it calls directly for that flow — it builds one
    or more `Persistable`s and returns them in `persist`; only `withUnitOfWork` (`diplomat/db`, invoked from the
    MCP/REST handler) touches `Db`. The unconverted bulk-import flow (phase 3c) is
    unaffected and keeps calling its `deps.transactions.create` write method exactly as before — this
    invariant applies per-flow, not repo-wide, until phase 3 finishes the migration. `deps.<x>.create/update/
    delete` methods for `accounts`, `tags`, `categories`, `subCategories`, and `creditCards` were checked for any
    remaining caller once their flow converted — found genuinely dead (grep-confirmed zero callers, production or
    test) — and removed in the same change rather than deferred (`AccountsRepo.update`/`.delete`,
    `TagsRepo.create`/`.delete`, `CategoriesRepo.create`/`.delete`, `SubCategoriesRepo.create`/`.delete`,
    `CreditCardsRepo.deleteCard`). `RecurringRepo.create`/`.advance` followed the same checked-and-removed path
    once both recurring flows converted (phase 3b) — grep-confirmed zero callers, removed in the same change.
    `deps.transactions.create` is the one write method still standing, since bulk import (phase 3c) is still its
    caller. `AccountsRepo.create`/`CreditCardsRepo.createWithAccount` were removed too —
    integration tests seeding fixture accounts/cards switched to raw drizzle inserts
    (`test/integration/db/unitOfWork.test.ts`'s `insertAccount`/`insertCreditCardWithAccount`) rather than keeping
    a production write method alive solely for test convenience. Two documented transitional duplications, both
    still repo-driven because their caller
    (`importAccountStatement`/`importCardStatement`, bulk import — phase 3c) needs an already-applied result per
    line, not a `Persistable`: `controllers/account/transaction.ts`'s `addAccountMovementViaRepo` (sharing
    `planAccountMovement`'s decision with the FC/IS `addAccountMovement`) and
    `controllers/creditCard/transaction.ts`'s `addCardPurchaseViaRepo` (sharing `planCardPurchase`'s decision
    with the FC/IS `addCardPurchase`, and — like the FC/IS path — setting `billId` at creation via a still-repo
    write method, `deps.bills.ensureOpen`, rather than a separate attach step). `controllers/transaction/core.ts`
    no longer carries an `updateTransaction`/`deleteTransaction` of its own — both aggregates' update/delete are
    now FC/IS, sharing only the pure `decideTransactionUpdate`/`resolveCategorySelection` reads-and-validation
    from the core.

## Tool surface

41 MCP tools (contract: `docs/mcp-tools.md`) and mirror REST routes, both thin over the same controllers. Client connections: `docs/mcp-clients.md`.

**Transport:** controlled by `MCP_TRANSPORT` (zod enum, `config.ts`). Default is **`stdio`** — the client spawns the process; no port, no Fastify. Set `MCP_TRANSPORT=http` to start the Fastify server (REST + streamable HTTP MCP on `PORT`). Both transports connect the same `buildMcpServer(deps, version)` core; no domain code moves. (ADR-007)

## HTTP sidecar (ADR-013 Decision 7)

In the default **stdio** transport, the HTTP server (REST + streamable HTTP MCP, `diplomat/http`/`diplomat/mcp`) runs alongside it as a **best-effort sidecar**, so `/api` and `/ui` are reachable by default — the dashboard experience is a core feature, not an add-on the user has to discover and opt into. Composed in `src/server.ts` (`buildHttpApp`, `startHttpSidecar`) and started from `main.ts`, the composition root — kept out of `diplomat/http`/`diplomat/mcp` so neither edge depends on the other.

- **On by default, opt-out via env:** `FINTRACK_HTTP` defaults to `true` (with `PORT`, default `51737` — see below), so the sidecar starts without any env var set. `FINTRACK_HTTP=false` is the only value that disables it (stdio-only, zero ports bound); any other value leaves it on.
- **Non-fatal bind failure is a fallback, not the normal state:** if the port can't be bound (most commonly `EADDRINUSE`), `startHttpSidecar` catches the error, logs an actionable message, and returns `{ listening: false }` instead of throwing. The stdio MCP connection — established before the sidecar is attempted — is unaffected either way; only `/api`/`/ui` stay unavailable for that run, and the user can diagnose the conflict from chat since stdio is still up.
- **stderr only, never stdout:** stdio carries the MCP protocol on stdout (ADR-007), so the sidecar's Fastify instance runs with `logger: false` and all sidecar messages (startup banner — including the `/ui/overview` URL so the user knows where to open the dashboard — and the bind-failure diagnostic) go through `console.error`.
- **Clean shutdown:** SIGINT/SIGTERM and stdin end/close (client disconnect) drain both the stdio server and the sidecar (only if it's actually listening) before the process exits.
- **Pure `http` mode is unchanged:** when `MCP_TRANSPORT=http`, the Fastify server (`buildHttpApp`, default `logger: true`) is the *only* surface running, so a bind failure there stays fatal (`process.exit(1)` with an actionable message) — there is no stdio fallback to keep the process alive. This is a deliberate, documented difference from the sidecar's non-fatal handling, not a regression.
- **Loopback-only bind (`common/net.ts`'s `LOOPBACK_HOST`, `127.0.0.1`):** both the sidecar and pure `http` mode bind `127.0.0.1` explicitly, never the `::`/`0.0.0.0` wildcard. This API has no auth (ADR-013 assumes local-first), and binding the wildcard address is reachable from any device on the same LAN, not just this machine — verified empirically, not just in theory. `localhost` may still fail to connect on systems where it resolves to IPv6 `::1`; clients should use `127.0.0.1` explicitly (`docs/mcp-clients.md`).
- **Default `PORT` differs by run mode, deliberately:** the published package (`config.ts`'s `DEFAULT_PORT`) defaults to `51737`, chosen because it sits in IANA's dynamic/private range (49152-65535) — never assigned to a registered service — rather than a common Node/Fastify/React dev-server port like 3000/3001/8080, which would maximize collision risk with other software on a typical machine. `npm run dev` overrides `PORT` back to the familiar `3001` (`package.json`), so a contributor's local dev instance never collides with an already-running installed instance on the published default. The two values are independent knobs, not a `NODE_ENV`-style branch in `config.ts` — only the npm script differs.

## OpenAPI contract (ADR-013 Phase A)

Every REST route is declared exactly once, in `diplomat/http/routes.ts`'s `buildRouteDefinitions(deps, version)` — a single array where each entry carries its method, path, `wire/in`/`wire/out`/`models`-derived request/response schemas, **and** its real handler together. There is no second, hand-maintained list to fall out of sync: `mountRoutes` (`diplomat/http/openapi.ts`) mounts the array on Fastify, and `buildOpenApiDocument` documents the same array via `@asteasolutions/zod-to-openapi`'s `OpenApiGeneratorV3` — neither function depends on the other, so a route that's mounted is, by construction, the same route that's documented. (An earlier version of this kept the route list and the OpenAPI registry as two separate, manually-synced files; that duplication was the actual defect, not something a parity test should merely detect after the fact — so the design was collapsed to one array instead. A unit test (`test/unit/diplomat/http/openapi.test.ts`) still checks the two consumers agree, mainly to guard against a future route being mounted by hand outside the array.)

The same document is exposed as the MCP resource `fintrack://openapi` (`diplomat/mcp/server.ts`), so a tools/resource-only agent — including under the **stdio** transport, which never starts Fastify — can read the contract without an HTTP round-trip. This is the first MCP resource in the app (as opposed to tools). It calls `buildOpenApiDocument(buildRouteDefinitions(deps, version), version)` directly: building the array only constructs handler closures (never invokes them), so it needs no live Fastify instance. `diplomat/mcp` importing `buildRouteDefinitions`/`buildOpenApiDocument` from `diplomat/http` is a narrow, documented exception to the dependency table (§ Dependency direction) — both are deterministic, no-business-logic builders, the same category of shared artifact both diplomats already import (wire schemas, models).

`diplomat/http/openapi.ts` holds only routing/doc-generation mechanics (`RouteDefinition`, `mountRoutes`, `buildOpenApiDocument`) — no wire schemas. Response shapes with no dedicated `wire/out` schema before this change (e.g. `BillView`, `ApplyDueResult`, the credit-card delete dry-run union, the shared `{ error }` envelopes for 404/409/422) got new small `wire/out` schemas (`wire/out/{bills,recurring,creditCards,common,errors}.ts`), same as any other response shape; request-side generic path-param/query shapes (`name`, `id`, `confirm`) got `wire/in/common.ts`. Unlike request schemas, these response schemas are not zod-validated at runtime (routes never parse their own outbound payloads), so they are best-effort documentation, not an enforced contract.

## Dashboards / `/ui` surface (ADR-013 Phase A/B)

The `dashboards` table (`name` PK, `html`, `updated_at`) stores agent-authored HTML shells, keyed by name — `save_dashboard` (MCP tool) / `POST /api/dashboards` (REST) is an **upsert**: saving to an existing name replaces its content immediately, no rebuild, restart, or migration. `GET /ui/:name` (mounted by `registerRoutes` in `diplomat/http/routes.ts`, same Fastify instance as `/api`, so it rides the HTTP sidecar per ADR-013 Decision 7) returns the currently-stored HTML as `text/html; charset=utf-8` with `cache-control: no-cache` — a regenerated dashboard is never masked by a stale browser copy. Absent name → `unknown_dashboard` (404).

Before persisting, `saveDashboard` (`controllers/dashboards.ts`) runs `findHtmlValidationIssues` (`logic/dashboard.ts`, pure) and rejects with `validation` (422) if it fails: no `<!doctype html>`/`<html>` root element, or an inline `<script>` that fails to *compile* (via Node's `vm.Script` — checked, never executed, so this can't itself run untrusted code). This is a narrow render-ability check, not sanitization: it exists because there was previously nothing stopping a broken save (e.g. a JS syntax error) from silently overwriting a working dashboard with no version history to recover from — full HTML sanitization remains explicitly out of scope for this local single-user app (ADR-013 Phase A). A rejected save never reaches `deps.dashboards.upsert`, so the previously stored dashboard is untouched.

`/ui/:name` is deliberately **not** part of the `/api` OpenAPI document: that document exists to give an agent correct `fetch()` shapes for the JSON data API (§ OpenAPI contract above), and `/ui` is a browser-facing HTML page, not a JSON contract. Management of dashboards (list/get/save) does have REST parity under `/api/dashboards*` and is documented in the OpenAPI spec like every other route.

A baseline dashboard (name `overview`) is seeded via `src/diplomat/db/seed/dashboards.ts` at bootstrap (ADR-008 seed isolation — consumed only by `diplomat/db/bootstrap.ts`, never imported by the domain), so `GET /ui/overview` resolves on a fresh install even before the agent has generated anything. Seeding uses `onConflictDoNothing` on the `name` primary key, so a `save_dashboard` override survives future restarts — bootstrap never re-seeds over a dashboard that already exists.

**(Phase B)** The seed is a single self-contained HTML string — layout, CSS, and vanilla JS all inline, with Chart.js loaded from a CDN as the only external resource. It renders income/expenses/balance, spending-by-category (chart + table), accounts & balances, recurring rules, and recent transactions, one block per currency, plus a clearly-labeled "coming soon" placeholder for installment projections (no endpoint exists yet — Phase C). On `DOMContentLoaded` it issues same-origin `fetch('/api/...')` calls against the routes documented at `GET /api/openapi.json` (`/api/summary`, `/api/aggregate`, `/api/accounts/balances`, `/api/recurring`, `/api/transactions`) and renders whatever comes back, using the localized labels the API already returns (`typeLabel`, `categoryName`, `periodLabel`, …) rather than hardcoding vocabulary. Every section has its own loading/empty/error state, so a slow or failing endpoint degrades one card instead of blanking the page. **The template embeds zero financial data or secrets** — this is the ADR-013 non-negotiable, and `test/integration/http/dashboardTemplate.test.ts` is a regression guard: it asserts the served HTML contains the expected `fetch()` calls, contains no inline-data-blob patterns (e.g. `const spending = [...]`), references no external host besides the Chart.js CDN, and that every fetched path exists in the live OpenAPI document.

**(Phase B)** `skills/dashboard-building/SKILL.md` is the guardrail checklist an MCP client follows to build or
adapt a dashboard for the user: read the contract (`fintrack://openapi`/`GET /api/openapi.json`) before
writing any `fetch()` call, map each requested section to a real endpoint, start from the baseline template
above as the structural pattern, then self-check the generated HTML (no embedded data, same-origin `/api`
only, the pinned Chart.js CDN script as the sole other external reference, per-currency grouping, localized
labels, loading/empty/error states) before calling `save_dashboard`. It is a docs-only artifact — no runtime
behavior depends on it — shipped in the published npm package via `package.json`'s `files` array so it's
available alongside the server.

## ADR index

- ADR-001: neverthrow for Result (reaffirmed vs fp-ts/Effect/Ramda)
- ADR-002: transfers are transactions with type 'transfer'
- ADR-003: remeda for declarative data transformation, with scope boundary
- ADR-004: local-first relational SQLite via libSQL (replaces Neo4j)
- ADR-005: OS keychain (`@napi-rs/keyring`) for encryption key storage
- ADR-006: Drizzle ORM for schema definition and migrations
- ADR-007: stdio as the default MCP transport, HTTP opt-in
- ADR-008: seed data lives in `diplomat/db/seed`; the domain never depends on it
- ADR-009: localized content lives on the entity (JSON `names`); i18n catalogs are for chrome only
- ADR-010: credit cards are liability accounts (1:1 internal `credit` account per card)
- ADR-011: safe composition of dynamic aggregation queries (whitelist enum→fragment maps + parameter binding)
- ADR-012: per-model error definitions; `common` composes `AppError` (supersedes the type-only `AppError` import exception)
- ADR-013: LLM-generated data-less local dashboards over the HTTP API
- ADR-014: cursor pagination + whitelisted ordering for collection endpoints (`search_transactions` first mover)
- ADR-015: multi-write unit-of-work for transactional multi-step writes — **rejected** (superseded by ADR-016 before implementation)
- ADR-016: domain/context boundaries — aggregate ownership (credit-card, account) over a shared transaction core
- ADR-017: no god write flows — bounded-context ownership for every transaction mutation (extends ADR-016; step 1 [update/delete split] and step 2 [bulk split] both implemented — complete; ownership discriminator revised by ADR-020)
- ADR-019: minimal transaction core — aggregates `.extend` the shared movement schema up, never `.omit` it down (step 1 [schema compose-up] and step 2 [logic re-homing] both implemented — complete)
- ADR-020: transaction ownership by account type, not structural field-presence (revises ADR-017's union rule; refines ADR-019 PR-2 — implemented)
- ADR-021: functional core / imperative shell for the write path — controllers return the write as data (a `persist` batch) instead of performing it; a generic versioned unit of work applies it (supersedes ADR-018)
