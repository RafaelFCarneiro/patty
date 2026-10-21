# ADR-021: Functional Core / Imperative Shell for the write path — the domain returns effects, the shell applies them

**Status:** Accepted (2026-07-13; phase 1 — groundwork + `createAccount` first mover — implemented; phase 2a —
account-context transaction flows + `PersistOutcome` idempotency-outcome plumbing — implemented 2026-07-13;
phase 2b — credit-card transaction flows + `billApplier`'s cycle-uniqueness-race-as-retry handling — implemented
2026-07-15; phase 2c — bill flows `pay_bill`/`revert_bill_payment`, completing the transaction+bill write path
and deleting the last bill write methods — implemented 2026-07-15; phase 3a — simple entity CRUD (account
update/delete, tag/category/sub-category/credit-card create/delete), including phase 3d's own removal of every
now-dead `deps` write method for those five entities — implemented 2026-07-15; phase 3b — recurring flows
(`create_recurring`/`apply_due_recurring`), including `applyDueRecurring`'s one-atomic-batch-per-run design and
phase 3d's own removal of `RecurringRepo.create`/`.advance`, which turned out to have no other caller — implemented
2026-07-16; phase 3c — bulk statement import (`import_card_statement`/`import_account_statement`) reusing the
single-line flows verbatim via `runEffectsSequence` (ADR-022 step 3), and phase 3d's own removal of the last
transaction-side write methods (`TransactionsRepo.create`/`.update`/`.delete`, `BillsRepo.ensureOpen`) — the last
two grep-confirmed already dead from phase 2b — implemented 2026-07-18; **final pass** — the three flows that sat
outside the ledger domain this ADR scoped (`confirm_transaction`, reusing `transactionApplier`; `save_dashboard`,
a new name-keyed `dashboardApplier`; `set_locale`, a new `settingsApplier`), closing the same violation
(a controller calling a repo write method) wherever it still existed — implemented 2026-07-18; **migration
complete: `deps` exposes no write method at all, for any entity in the codebase**) · **Date:** 2026-07-12 ·
**Deciders:** Rafael · **Supersedes ADR-018** (atomic bill payment) and finally resolves the thread ADR-015
opened. Adopts the principle documented in `docs/functional-core-imperative-shell.md` for every write flow.

**Amendment (ADR-022):** the executor this ADR introduced (`withUnitOfWork`, `diplomat/db/unitOfWork.ts`) is
renamed to `runEffects` (`diplomat/db/effects.ts`) and reframed as a generic effect runner; "unit of work"
survives only as the name of its single-atomic-unit mode. The rest of this ADR is left as the historical record
of the original decision and still refers to the pre-rename names throughout — see ADR-022 for the current ones.

## Context

Every write flow in this codebase drives its own persistence: controllers `await` injected repo write methods
(`deps.transactions.create`, `deps.bills.markPaid`, `deps.bills.ensureAndAttach`) inside their `safeTry` flow.
That single fact — **the domain executes writes** — is the root cause of a problem this project has circled
repeatedly:

- **ADR-015** (rejected) tried to make multi-write flows atomic by adding a transactional repo method that
  applied a typed delta with CAS guards. It leaked domain rules into `diplomat/db`.
- **ADR-016/017/019/020** removed the *cross-domain* coupling by fixing bounded contexts, shrinking the
  multi-write surface to one flow (`payBill`).
- **ADR-018** then closed that one flow with a transactional `bills.pay` method — and re-introduced the exact
  ADR-015 smell at aggregate scale: the *repo* now knows a bill payment is "insert a transfer + flip the bill
  status." Tests like `billsEnsureAndAttach`, `addCardPurchaseSelfHeal`, and
  `updateCardTransactionReassignAtomicity` (under `test/integration/db/`) — and the bill-payment atomicity test
  ADR-018 would add — exist **only because** business flow and its atomicity concerns live
  in the repository layer.

As long as the domain applies its own writes, atomicity has nowhere to live but inside the repo, so the repo
keeps accreting business knowledge. The fix is not a better repo method — it is to **stop the domain from
applying writes at all.**

## Decision (proposed)

**Adopt Functional Core / Imperative Shell for the entire write path (`docs/functional-core-imperative-shell.md`).
Controllers become pure decisions: they read (injected queries), validate, and return
`ResultAsync<{ persist: Persistable[]; response: T }, AppError>` — a description of the writes plus the response —
without performing any write. A generic, versioned Unit of Work in the diplomat shell applies the batch in one
`db.transaction` and returns the response. Repos hold no business process; concurrency is a generic `version`
guard on the model.**

1. **`Persistable`** — a discriminated union over an `EntityTag` enum, wrapping a domain model + intent:
   `{op:'insert', entity, model}` / `{op:'update', entity, model /*carries version*/}` /
   `{op:'delete', entity, id, version}`. Built by the core in model vocabulary; the shell runs each through the
   existing `modelToDb` adapter and the matching table op.

2. **Controllers return effects, not perform them.** `safeTry` still short-circuits validation on the error
   track; reads stay injected (`deps.<x>.get/find/search`). The write calls (`deps.x.create/update/...`) are
   replaced by *accumulating a `Persistable`*. Flows compose by **merging** `persist` arrays (e.g. `payBill`
   calls the transfer controller, takes its `persist`, adds its own bill `update`, returns the merged batch).

3. **The Unit of Work (diplomat shell, `diplomat/db`).** `withUnitOfWork(deps, () => controller(deps, input))`:
   invoke the controller; apply its `persist` batch in one `db.transaction` (`modelToDb` + insert /
   version-guarded update / version-guarded delete; inserts honor the existing idempotency
   `onConflictDoNothing`); on any `rowsAffected === 0` version mismatch, roll back and **re-invoke the
   controller** (fresh reads → fresh decision) up to a bounded number of attempts, then return a generic
   `conflict` `AppError`. The shell owns atomicity, versioning, and retry — generically, once.

4. **`version` column on every mutable table** (migration). Reads surface it on the model; the shell bumps it on
   every update/delete. It is an internal concurrency token (not `wire/out`).

5. **`deps` loses its write methods.** After migration `deps` exposes queries + `newId`/`clock`/`locale` only;
   the per-flow transactional repo methods (`create`, `update`, `markPaid`, `ensureAndAttach`, `revertPayment`,
   `pay`, …) are deleted in favor of the generic applier.

6. **Idempotency-aware responses.** Flows whose response depends on apply outcome (bulk import: created vs
   duplicate-skipped) receive the shell's per-item batch outcome and shape their response from it; all other
   flows return a fully core-derived response.

## Options Considered

### Option A — Status quo / ADR-018: domain drives writes via transactional repo methods (rejected)
Atomicity lives in the repo, so the repo learns each business process. Every new multi-write flow re-derives a
bespoke transactional method and its atomicity tests. The coupling this project keeps rediscovering.

### Option B — Functional Core / Imperative Shell; core returns `Persistable[]`, shell applies (chosen)
| Dimension | Assessment |
| --- | --- |
| Repo knowledge | Zero business process — a generic versioned applier |
| Atomicity/concurrency | Generic, owned by the shell once (one transaction + `version` guard + retry) |
| Domain purity | Controllers are pure decisions over injected reads; writes are returned data |
| Testability | Flow tests assert on returned effects (no DB); the UoW is tested once |
| Cost | Large re-architecture of the write path; a `version` migration; a `Persistable`/UoW abstraction |

### Option C — Keep ADR-018's `bills.pay`, accept repo-held process for "just this flow" (rejected)
It is never just one flow — this is the fourth time the same coupling has appeared (create self-heal, ensure-and-
attach, update reassign, bill pay). Accepting it cements the smell and the tests that come with it.

## Trade-off Analysis

The tension is **a large, foundational re-architecture vs. a permanently clean write boundary.** Option A/C are
cheap per-flow but pay forever: the repo is on the business-critical path, every multi-write flow needs a bespoke
transactional method, and each ships atomicity tests that only exist because the flow applies its own writes.
Option B is a real investment — a `version` migration, a `Persistable` union, a generic UoW, and converting every
write flow — but it buys a boundary where the repository is swappable and dumb, atomicity/concurrency are solved
once generically, domain flows are pure and tested without a database, and the class of leaked-process tests
disappears. Given the write path is the heart of a finance app and this coupling has recurred four times, the
investment is warranted. The main risks are bounded and known: the `Persistable` union must stay typed
(entity-tagged models, not a god-changeset — call it out in review), and read-your-own-writes within a single
flow is not supported (reads happen before the write batch) — acceptable here, where every flow is
read → decide → write with version guards.

## Consequences

- **Supersedes ADR-018.** `bills.pay` is not built (or is reverted if merged); `payBill` returns a `persist`
  batch (`insert` transfer + version-guarded `update` bill to `paid`); the shell applies it atomically. The
  status-conditioned write becomes the generic `version` guard.
- **Closes the ADR-015 thread for good.** The concurrency mechanism ADR-015/016 groped for (versioning, CAS-as-
  data) lands in its correct home: a `version` field the core returns on the model, enforced by a generic shell —
  never in the repo.
- **Removed**: per-flow transactional repo methods and their atomicity/self-heal tests
  (`billsEnsureAndAttach`, `addCardPurchaseSelfHeal`, `updateCardTransactionReassignAtomicity`, and the
  bill-payment atomicity test ADR-018 would have added); `deps` write methods.
- **Added**: `version` columns (migration); `Persistable`/`EntityTag`; `withUnitOfWork` + the generic applier; a
  generic `conflict` `AppError`.
- **Docs**: `docs/functional-core-imperative-shell.md` becomes mandatory reading; `docs/architecture.md` and
  `CLAUDE.md` reference it as such (like `docs/diplomatic-architecture.md`); `docs/code-style.md` gains the
  return-effects-not-perform-them controller pattern.

## Migration plan (phased — this is large; each phase behind the full gate)

1. **Groundwork**: `version` migration on mutable tables; `Persistable`/`EntityTag`; the generic versioned
   applier + `withUnitOfWork`; wire it for **one** simple flow end-to-end (e.g. `createAccount`) to prove the
   shape. Old repo write methods remain for unconverted flows.
2. **Transaction + bill flows**: convert `add_*`/`update_*`/`delete_*`, `payBill`/`revertBillPayment` to return
   `persist`; delete `bills.pay`/`ensureAndAttach`/self-heal and their atomicity tests; `payBill` composes the
   transfer controller's `persist`.
3. **Remaining flows**: bulk import (idempotency-aware outcomes), recurring, card/category/tag CRUD; remove write
   methods from `deps`; delete the now-dead transactional repo methods.
4. Update `docs/architecture.md` (dependency table: domain returns effects; shell applies), the mandatory-doc
   references, and `docs/code-style.md`.

Each converted flow's test moves from "apply + assert DB state" to "assert the returned `persist` batch"; the UoW
gets its own generic atomicity/conflict/idempotency suite.

## Action Items

1. [x] Review/accept this ADR (decision review — no implementation in this PR).
2. [x] On acceptance: add this ADR to the `docs/architecture.md` index; reference
   `docs/functional-core-imperative-shell.md` as mandatory in `docs/architecture.md` + `CLAUDE.md` (alongside
   `docs/diplomatic-architecture.md`); flip that doc's status note to adopted.
3. [x] Do NOT merge `feat/atomic-bill-payment` (ADR-018) — it is superseded by this decision (PR #111 closed).
4. [x] Implement phases 1–3 (groundwork → transaction/bill flows → remaining), behavior-preserving where the
   surface allows, coverage moved to core-level effect assertions + the generic UoW suite.
   - [x] Phase 1 (groundwork): `version` migration on all mutable entity tables; `Persistable`/`PersistOp`
     (`models/persistable.ts`) — generic over the entity's own tag/model, not a closed union, so the shared
     file never lists an entity itself; each entity owns its own tag constant on its own model file (e.g.
     `models/account.ts`'s `ACCOUNT_ENTITY_TAG`); the generic versioned applier + `withUnitOfWork`
     (`diplomat/db/unitOfWork.ts`) dispatches via an `ApplierRegistry` (entity tag → `EntityApplier`) assembled
     once at the composition root, so the engine itself never names a specific entity either — with its own
     atomicity/conflict/retry/idempotent-insert/agnostic-dispatch suite; `createAccount` converted end to end
     (MCP + REST) as the first mover — proves the shape. Refined further: the `modelToDb` adaptation moved out
     of `diplomat/db` entirely — the MCP/REST handler now adapts model → row explicitly (`adapters/
     accounts.ts`'s `outcomeToDb`) before ever calling `unitOfWork`, so both the generic engine *and* each
     entity's `EntityApplier` only ever write rows they're handed, never adapt one themselves. Refined once
     more: with adaptation gone, an `EntityApplier`'s `insert`/`update`/`delete` are now identical mechanics
     for any table keyed by `id` with a `version` column (8 of the 9 mutable tables — `dashboards` keys on
     `name` instead), so `diplomat/db/unitOfWork.ts` exports `versionedTableApplier(table)` to build one from
     just the table reference; `accountApplier` is `versionedTableApplier(accounts)`, no hand-written
     insert/update/delete left at all.
   - [x] Phase 2a (account-context transaction flows): `add_account_expense`/`add_account_income`/
     `create_transfer`/`update_account_transaction`/`delete_account_transaction` converted end to end (MCP +
     REST). A custom `transactionApplier` (`diplomat/db/repos/transactions.ts`) — not
     `versionedTableApplier`, since a transaction row has genuine extra mechanics beyond `id`/`version`
     (`insert` conflicts on `idempotency_key`, not `id`; merchant upsert; tag attach/replace) — registered
     under `models/transaction.ts`'s `TRANSACTION_ENTITY_TAG`. Added the UoW idempotency-outcome contract
     rule 6 describes: `PersistOutcome` (`models/persistable.ts`) — `applied` + an entity-decoded `read` of
     what's now actually persisted — reported per-persistable by `withUnitOfWork`; `FlowOutcome.response` may
     be the plain value (unchanged for `createAccount`) or a pure, sync function of the batch's
     `PersistOutcome[]`, which is how `created` is derived (never faked). `response` stays data-shaping only —
     `updateAccountTransaction`'s merchant-learning (a category correction strengthens the merchant→category
     edge) is a *further write*, not response-shaping, so it rides in the same `persist` batch as the
     transaction update instead (rule 5), via its own minimal entity (`models/merchant.ts`'s
     `MERCHANT_CATEGORY_ENTITY_TAG`, `diplomat/db/repos/merchants.ts`'s `merchantCategoryApplier` — an
     upsert-increment `insert`-only applier, since `merchant_category` has no `id`/`version` and is never
     `update`d/`delete`d in the versioned-entity sense) — atomic with the update it came from, and never fired
     on a version-conflict attempt that gets rolled back and retried. Since `response` is now genuinely pure in
     every converted flow, moved the mechanical part out of each controller and into named, unit-tested functions
     in `logic/transaction.ts`, deliberately not named "response" (they build/format a model, not an HTTP/MCP
     response): `viewFromOutcome`/`buildTransactionView` resolve a bare `TransactionView` (no `created`/
     `classification` envelope — `update_account_transaction`'s shape), and `buildUpsertResult` resolves
     `models/transaction.ts`'s new `UpsertTransactionResult` (`{ transaction, created, classification? }` —
     replaces the old `CreateTransactionResult`, `classification` now optional) directly: `create_transfer`
     calls it with `classification: undefined`, `add_account_expense`/`add_account_income` with a real one —
     `ClassifiedUpsertResult` names the narrowing (`classification` required) those two, `add_card_purchase`,
     and bulk import actually return, used for `addCardPurchase`'s/`addAccountMovementViaRepo`'s/
     `StatementLineCreateFn`'s/`toBulkItemResult`'s declared types so the classification-always-present
     guarantee those flows already had doesn't silently erode. One shared result shape, not a bespoke envelope
     assembled per flow — `add_account_expense` no longer needs to compose `{ transaction, created }` plus its
     own `classification` at the call site at all. Each `logic/transaction.ts` function is `purry`'d data-last
     on the non-`outcomes` args (the dual-calling convention `docs/code-quality.md` already established for
     `addLocalizedLabels`/`withTypeLabel`), so e.g. `buildUpsertResult(classification, locale)` *is* the
     `(outcomes) => T` function `FlowOutcome.response` wants — every converted flow assigns it directly
     (`const response = buildUpsertResult(classification, locale)`), no wrapping arrow at any call site.
     Normalized the merchants repo alongside this: the old `strengthenFromTransaction(transactionId, categoryId)`
     re-queried `transactions` to resolve a merchant key itself — a business-shaped repo method name and behavior
     (`docs/diplomatic-architecture.md`: repos "should contain no business logic"). Replaced with
     `incrementCategoryWeight(merchantKey, categoryId)`, pure upsert-increment mechanics shared (one function,
     `upsertCategoryWeight`) by both the repo method and `merchantCategoryApplier`; the "is this actually a
     correction worth learning from" decision moved to a named resolver, `logic/merchant.ts`'s
     `resolveMerchantCorrection(existing, newCategoryId)` — returns the `{merchantKey, categoryId}` edge to
     write or `null`, a single check rather than a caller-side emptiness guard plus a same-ness comparison —
     used by both the old `updateTransaction` (still repo-driven, calls
     `deps.merchants.incrementCategoryWeight` directly — a real write from a controller is expected and
     correct for an unconverted flow) and the new `updateAccountTransaction` (composes the resolved edge into
     `persist` as a `MERCHANT_CATEGORY_ENTITY_TAG` insert instead) — one rule, decided once, applied through
     each flow's own write mechanism. Behavior-preserving otherwise:
     `controllers/account/transaction.ts`'s `addAccountMovementViaRepo` keeps the old `deps.transactions.create`
     path for `importAccountStatement` (bulk import isn't converted until phase 3) and
     `controllers/transaction/core.ts`'s `updateTransaction`/`deleteTransaction` are unchanged (still used by
     the not-yet-converted credit-card aggregate) — both share their read/decision logic with the converted
     account-side flows via extracted pure planners (`planAccountMovement`, `decideTransactionUpdate`) rather
     than duplicating it outright.
   - [x] Phase 2b (credit-card transaction flows): `add_card_purchase`/`update_card_transaction`/
     `delete_card_transaction` converted end to end (MCP + REST). `bills.ensureAndAttach` and its compensating
     self-heal (the delete-on-attach-failure branch `addCardPurchase` used to run) are **deleted**, along with
     their three atomicity/self-heal integration tests (`billsEnsureAndAttach`, `addCardPurchaseSelfHeal`,
     `updateCardTransactionReassignAtomicity`) — the conditions they guarded no longer exist, because the flow
     no longer applies its own writes (`docs/functional-core-imperative-shell.md`'s "testing implications").
     A bill entity (`models/bill.ts`'s `BILL_ENTITY_TAG`, `BillEntity`, and a `RawBill` — `Bill` extended with
     the internal `version`/`creditCardId` fields a write needs but a read response never exposes, mirroring
     `RawTransactionView`) is registered under `diplomat/db/repos/bills.ts`'s `billApplier`. Bills fit the
     `id`/`version` convention for `update`/`delete` (`versionedTableApplier(bills)`), but creation is
     upsert-by-cycle (`UNIQUE(creditCardId, month, year)`), not by `id` — a genuine concurrent-first-purchase
     race on the same cycle surfaces as a raw unique-constraint error from `versionedTableApplier`'s own
     `onConflictDoNothing` (scoped to `id` only), which `billApplier`'s own `insert` recognizes and rethrows as
     `withUnitOfWork`'s own `VersionConflict` (newly **exported** from `diplomat/db/unitOfWork.ts` for exactly
     this case) — the whole batch rolls back and the flow re-invokes, re-reading `findByCycle` and emitting a
     version-guarded *touch* of the winner's row instead of a second insert, never a wrong-id no-op. The
     "ensure" decision itself (insert-a-fresh-`open`-bill vs. touch-the-existing-one) moved to the domain as
     `controllers/credit-card/transaction.ts`'s `resolveBillWrite`, shared by `addCardPurchase` (new cycle) and
     `updateCardTransaction`'s reassignment branch (target cycle); the transaction row carries `billId` at
     insert/update, so there is no separate attach step and no orphan to self-heal. Guard-what-you-validated:
     every bill whose paid status the flow read is also version-guarded in the same batch — `addCardPurchase`
     touches the target bill it validated; `updateCardTransaction`'s reassignment touches both the current and
     target bill (deduped to one touch when they're the same cycle, to avoid a spurious self-conflict);
     `deleteCardTransaction` touches the transaction's own bill — so a concurrent `pay_bill` landing between the
     read and the shell's apply rolls the batch back and re-invokes the flow, which then sees `paid` for real,
     rather than racing past a paid bill. Because the transaction row's `bill_id` FK must reference a bill that
     already exists when it's a fresh insert, the bill `Persistable`(s) apply *before* the transaction one in
     these two flows' batches — the flow's own entity trails the batch instead of leading it, the reverse of
     every flow phase 2a converted — so `logic/persistence.ts` gained `lastOutcome` (`firstOutcome`'s
     counterpart) for `response` to resolve against. `updateCardTransaction`/`deleteCardTransaction` no longer
     delegate to `controllers/transaction/core.ts`'s `updateTransaction`/`deleteTransaction` (both **deleted** —
     unreachable dead code the moment the credit-card aggregate stopped calling them); both aggregates' FC/IS
     update flows now share only the pure `decideTransactionUpdate`/`resolveCategorySelection` reads from the
     core. `importCardStatement` (bulk import, unconverted until phase 3) keeps a legacy repo-write path
     (`addCardPurchaseViaRepo`, mirroring phase 2a's `addAccountMovementViaRepo`) sharing `planCardPurchase`'s
     decision with the FC/IS `addCardPurchase`; it sets `billId` at creation too (via a new, narrow
     `deps.bills.ensureOpen` — idempotent upsert-by-cycle, no paid-guard, no attach — replacing the paid-guard
     and attach concerns `ensureAndAttach` used to fold in, which move to the caller either way), so it never
     needed the deleted self-heal either. Behavior-preserving: a pre-existing gap where a plain,
     non-reassignment `update_card_transaction` edit does **not** check the transaction's current bill's paid
     status at all (only a `billMonth`/`billYear` reassignment ever reads a bill) is deliberately left as-is,
     matching prior behavior exactly. `updateCardTransaction` also composes the same merchant-learning write
     phase 2a gave `updateAccountTransaction` — a category correction inserts a `MERCHANT_CATEGORY_ENTITY_TAG`
     `Persistable` (`resolveMerchantCorrection`) into the same atomic batch — positioned *before* the
     transaction update rather than after (unlike the account-side flow, where the transaction leads and
     merchant-learning trails): this flow's own transaction `Persistable` must stay the batch's last element for
     `lastOutcome` to resolve it correctly, so every other persistable — bill(s), then merchant-learning —
     precedes it.
   - [x] Phase 2c (bill flows): `payBill`/`revertBillPayment` converted end to end (MCP + REST); `bills.pay`
     was never built (see Consequences), so nothing to revert there. Neither flow's response is
     idempotency-aware (rule 6's `PersistOutcome`-derived function) — unlike phase 2b's card-purchase flows,
     both mint every id and read every field the response needs *before* building the batch (a fresh `newId()`
     transfer id for `payBill`, the already-read `RawBill` for both), so `response` is the plain value two new
     helpers return alongside their `Persistable`: `buildPaidBillWrite` (a version-guarded bill `update` to
     `paid`, with or without a `paymentTransactionId`) and `buildClosedBillWrite` (a version-guarded bill
     `update` to `closed`, clearing it). `payBill`'s positive-total batch is `[transfer insert, bill update]` —
     the transfer must exist before the bill update that points `payment_transaction_id` at it; a non-positive
     total emits just the bill update, no transfer. `revertBillPayment`'s batch reverses that order —
     `[bill update, transfer remove]` — since `bills.payment_transaction_id` (no `ON DELETE` action) must be
     cleared before the transfer row it references can be deleted, and libsql enforces foreign keys by default
     (mirrors the pre-ADR-021 `revertPayment` repo method's own "FK-safe order" comment); a paid bill with no
     transfer (non-positive-total pay) emits just the bill update. This is why `models/bill.ts`'s
     `BillEntity.paymentTransactionId` widened to `string | null | undefined`: `undefined` leaves the column
     unchanged (drizzle's `.set()` drops `undefined`-valued keys), `null` explicitly clears it — the same
     convention `TransactionsRepo.update`'s `subCategoryId` already established. `revertBillPayment`'s
     `tryFindPaymentTransaction` returns `null` both when the bill never had a payment transfer and when
     `paymentTransactionId` no longer resolves (e.g. a concurrent `delete_credit_card` — still repo-driven,
     not yet on this shell — removed it between `revertBillPayment`'s own un-batched reads); either way the
     batch just carries the bill update alone. If the bill itself was also concurrently deleted, that
     update's version guard fails at apply time and the shell's retry resolves it to a clean `unknown_bill`
     instead of a 500 — no throw needed for what is a legitimate, if narrow, race, not corruption.
     Deletes the last bill write methods: `deps.bills.markPaid`/`revertPayment`/`setStatus` (the last had no
     other caller once these two flows converted) — `BillsRepo` now exposes only reads
     (`get`/`findByCycle`/`findById`) plus the still-repo-driven `ensureOpen` (bulk import, phase 3). Coverage:
     pure flow tests assert the returned `persist`/`response` for every branch (positive/non-positive total,
     already-paid/not-paid idempotency, payer validation failures, revert with/without a transfer); a UoW-level
     suite (`test/integration/db/unitOfWork.test.ts`) replaces the bill-payment atomicity test ADR-018 would
     have added — two sequential `pay_bill` calls land exactly one transfer and one paid flip, and a simulated
     concurrent bill mutation (a version bump landing between `payBill`'s read and the shell's write) rolls
     back the whole batch — transfer included — and recovers cleanly on retry, leaving no partial write.
   - [x] Phase 3a (simple entity CRUD): `update_account`/`delete_account` (the applier already existed from
     phase 1 — `accountsRepo.findRawById` added for the version-carrying read the flows needed),
     `create_tag`/`delete_tag`, `create_category`/`delete_category`/`create_sub_category`/`delete_sub_category`,
     `create_credit_card`/`delete_credit_card` converted end to end (MCP + REST). Three new entities, each owning
     its own tag (`models/tag.ts`'s `TAG_ENTITY_TAG`, `models/category.ts`'s `CATEGORY_ENTITY_TAG`,
     `models/credit-card.ts`'s `CREDIT_CARD_ENTITY_TAG`). `tagApplier` (`diplomat/db/repos/tags.ts`) mirrors
     `billApplier`'s pattern: `tags.name` carries its own `UNIQUE` constraint beyond the `id`-scoped
     `onConflictDoNothing`, so a concurrent same-name create surfaces as a genuine unique-constraint violation,
     recognized and rethrown as `VersionConflict` — the retried flow's own `assertTagNameAvailable` then sees
     the committed row and returns `duplicate_name` instead of a raw 500. The shared cause-chain-walking
     unique-constraint check moved out of `bills.ts` into `diplomat/db/sqlite-errors.ts`'s
     `isUniqueConstraintViolation`, used by both appliers now. `deleteTag` stays idempotent-by-design (delete by
     id, no name resolution): a missing id returns `{ deleted: false }` on an empty `persist` batch, unchanged
     pre-ADR-021 behavior — not an error. `categoryApplier` (`diplomat/db/repos/categories.ts`) is shared by a
     top-level category and a sub-category (same table, `parentId` set or not) and is plain
     `versionedTableApplier(categories)`. It first shipped with a hand-written `delete` that purged dependent
     `merchant_category` rows itself first (`merchant_category.category_id` had no `ON DELETE` action, so a
     plain delete would otherwise violate the FK while a learned association still pointed at the category) —
     caught in review as the same layering slip `creditCardApplier` (below) had, the repo hand-implementing a
     referential-integrity mechanic that belongs to the schema. Unlike the credit-card cascade, though, this one
     is *pure mechanics* with zero decision in it — no reads, no branching, always the identical unconditional
     cascade whenever a category disappears (the domain's own `isCategoryUnreferenced` guard already
     deliberately leaves merchant learning out of what *blocks* a delete — deleting a category is meant to also
     clear its learned classifications, re-learnable later — so there was never a decision for the domain to
     make here), making it structurally identical to `transaction_tags.transaction_id`'s existing
     `ON DELETE CASCADE`. Moved there: `merchant_category.category_id` now references `categories.id` with
     `{ onDelete: 'cascade' }` (migration `drizzle/0010_category_merchant_association_cascade.sql`); the
     now-redundant `categoriesRepo.delete`/`subCategoriesRepo.delete` repo methods dropped their manual
     `merchant_category` cleanup (the cascade handles it) — and, once checked, turned out to have no other
     caller left at all (see the `deps` write-method note below), so they were removed outright rather than kept
     simplified. `creditCardApplier` (`diplomat/db/repos/credit-cards.ts`) is plain
     `versionedTableApplier(creditCards)` — a first version of this applier read the card's own `accountId`
     back and cascade-deleted every correlated bill/transaction/tag itself, mirroring the pre-ADR-021
     `deleteCard`'s cascade; caught in review as the repo deciding a business question ("what happens when a
     card is deleted") — the exact ADR-015/018 smell this whole ADR exists to remove, recurring one layer down
     — and fixed before merge. **The cascade decision now lives in the domain.** `deleteCreditCard`
     (`controllers/credit-card/credit-card.ts`) reads every bill (`billsRepo.findAllByCard`, new) and transaction
     (`transactionsRepo.findAllCorrelatedToCard`, new) correlated to the card and emits their own removal as
     explicit `Persistable`s, in FK-safe order. A bill with a payment transfer has a **circular reference** with
     it (`bills.payment_transaction_id` → the transfer; the transfer's own `bill_id` → the bill; no `ON DELETE`
     action on either column, libsql enforces foreign keys) — cleared first via an `update`
     (`paymentTransactionId: null`), then every correlated transaction removed (`transaction_tags` cascades via
     its own schema-declared `ON DELETE CASCADE` — a genuine DB mechanic, not a business decision, so it never
     becomes a `Persistable`), then every bill, then the card, then its internal liability account. A bill
     that received the clearing `update` is removed at `bill.version + 1` — the version the shell will have
     already bumped it to by the time that delete applies in the same batch (rule 4's `model.version + 1` is
     deterministic, so the domain can compute it too) — not the version read at decision time, which the update
     already moved past; carrying the stale read version there would be a false, unresolvable version conflict.
     `deleteCreditCard`'s batch is therefore variable-length — `[...bill-clears, ...transaction removals,
     ...bill removals, remove creditCard, remove account]` — genuine rule-5 multi-entity composition, not the
     two-entity batch a repo-side cascade let this flow get away with. `createCreditCard` stays a two-entity
     insert batch — `[insert account, insert creditCard]`, account first since the card row's `accountId` is a
     `NOT NULL` FK into it. **`deps.<x>` write methods for these five entities were grep-checked for any
     remaining caller (production or test) rather than assumed still needed, per the phase 2a/2b/2c
     transitional-duplication precedent** — and found genuinely dead: `AccountsRepo.update`/`.delete`,
     `TagsRepo.create`/`.delete`, `CategoriesRepo.create`/`.delete`, `SubCategoriesRepo.create`/`.delete`, and
     `CreditCardsRepo.deleteCard` (plus the `cascadeDeleteCorrelated` helper the last one was `deleteCard`'s own
     sole remaining caller for) all removed in this same change — phase 3d completed early for these five,
     rather than deferred, since there was no other caller left to defer *for*. `AccountsRepo.create`/
     `CreditCardsRepo.createWithAccount` were removed too, once their one remaining caller (integration-test
     fixture seeding) switched to raw drizzle inserts (`test/integration/db/unitOfWork.test.ts`'s
     `insertAccount`/`insertCreditCardWithAccount`) instead of keeping a production write method alive solely
     for test convenience. Coverage: pure flow tests assert the returned `persist`/`response` for every branch
     (no correlated rows, an unpaid bill, a paid bill's clear-then-remove-at-version+1); a UoW-level suite
     extension covers `tagApplier`'s name-race retry, that a
     plain versioned category delete still removes dependent `merchant_category` rows (now via the schema's own
     cascade, not `categoryApplier` code — including the sub-category case), that `creditCardApplier`
     genuinely has no cascade of its own (a correlated bill left behind now surfaces the generic conflict —
     `versionedTableApplier`'s `delete` catches the FK violation and retries, per its own later refinement
     below — not a silent removal), and an end-to-end test running the real `deleteCreditCard` controller
     through the real
     shell against a seeded DB (two bills — one paid with its payment transfer, one unpaid — plus ordinary
     purchases and a tag) to prove the whole domain-decided batch, including the circular-FK break, commits
     atomically. **Refined further:** every converted entity's `persistableToDb`/`outcomeToDb` pair had been
     hand-written to the same op-switch shape (no-op on a foreign entity tag; `insert` bakes in
     `INITIAL_VERSION`; `update` shapes the already-versioned model; `delete` passes through) — the adapter-side
     duplication `versionedTableApplier` had already removed on the applier side. `logic/persistence.ts`'s
     `entityDbAdapter(entityTag, modelToDb)` factors it out the same way: every adapter now supplies just its
     own `modelToDb` and one line building `persistableToDb`/`outcomeToDb` from it. `tags`, whose domain model
     already matches its row shape 1:1 once versioned, gained a small identity `modelToDb` rather than being
     special-cased out of the factory. `bills` did not fit: its pre-existing `update` branch was a bare
     passthrough (`return p`) for a real reason, not an oversight — `paymentTransactionId: undefined` means
     "leave the column unchanged" (drizzle's `.set()` drops undefined-valued keys), `null` means "clear it"
     (`payBill`'s zero-total path, `models/bill.ts`), a distinction a uniform `modelToDb` called on every
     `update` collapses into always-`null`. Caught in review before merge; `adapters/bills.ts` kept its own
     hand-written `persistableToDb`/`outcomeToDb`, unchanged by this factor-out.
   - [x] Phase 3b (recurring): `create_recurring`/`apply_due_recurring` converted end to end (MCP + REST). New
     `models/recurring.ts` `RECURRING_ENTITY_TAG`/`RecurringRuleEntitySchema` (versioned, kept off the
     wire-facing view schemas) and `recurringRuleApplier` — plain `versionedTableApplier(recurringRules)`, the
     row shape already matched the table 1:1. `createRecurring` is a one-entity insert batch, response built
     from the already-resolved account/category (rule 6). `applyDueRecurring` computes every due rule's
     occurrences (bounded, `MAX_RECURRING_OCCURRENCES_PER_RUN`) and advanced `nextDue` in the domain and emits
     **one merged batch across every due rule** — every occurrence as a `transactionApplier` insert (phase 2a's
     applier, reused as-is) followed by every rule's own version-guarded `advance` update — applied atomically;
     `ApplyDueResult` is shaped from the shell's per-insert outcomes via `viewFromOutcome`, same idempotency-
     outcome contract as phase 2a, never inferred by the domain. **Atomicity-granularity decision:** the
     pre-ADR-021 code advanced each rule independently; this phase batches every due rule into one unit of work
     instead — a version conflict retries the whole run, safe because `rec-<ruleId>-<date>` idempotency keys
     make re-materialization a no-op. `RecurringRepo.create`/`.advance` were grep-checked for any remaining
     caller once both flows converted — found genuinely dead (zero callers, production or test) — and removed
     in this same change, phase 3d completed early for recurring, same as phase 3a's five entities. Coverage:
     pure flow tests for both flows (insert shape, the occurrence+advance batch for single/multiple due rules
     and multiple rules together, the idempotency-outcome response including a duplicate-replay case), a
     UoW-level check that the applier is a plain versioned table applier, and the existing MCP/REST integration
     suites (materialization, `through`, idempotent re-run) passing unchanged through the new shell path.
   - [x] Phase 3c (bulk import — reusing phase 2a's `PersistOutcome` idempotency-outcome contract, generalized to
     `runEffectsSequence`'s per-unit `SequenceOutcome` for per-item created/duplicate/needs-review status —
     ADR-022 step 3): `import_card_statement`/`import_account_statement` (`controllers/credit-card/transaction.ts`/
     `controllers/account/transaction.ts`) default each line (`controllers/transaction/bulk.ts`'s
     `defaultStatementLines`) and return a `StatementImportPlan` — the defaulted lines plus a `flowFor` binding
     one line to the aggregate's own single-line flow (`addCardPurchase`, `addAccountExpense`/`addAccountIncome`)
     **unchanged** — for the MCP/REST handler to run through `runEffectsSequence`, then shape back into
     `BulkResult` via `bulk.ts`'s `buildBulkResult`. The within-batch bill-cycle dedup `addCardPurchaseViaRepo`
     needed is **dissolved, not ported**: `runEffectsSequence` re-invokes each line's flow only after the prior
     line committed (ADR-022 decision 4), so a second line targeting a brand-new cycle simply reads the bill the
     first line's flow just inserted. `docs/architecture.md` updated accordingly. Phase 3d (remove now-dead
     `deps` write methods across every converted entity) completed early for accounts/tags/categories/
     subCategories/creditCards as part of phase 3a, and for recurring (`RecurringRepo.create`/`.advance`) as part
     of phase 3b (see above); phase 3c completes the rest: `addAccountMovementViaRepo`/`addCardPurchaseViaRepo`
     and the write methods they were the last callers of (`deps.transactions.create`, `deps.bills.ensureOpen`)
     are deleted, and the same grep sweep found `TransactionsRepo.update`/`.delete` had already had zero callers
     since phase 2b — removed alongside (their sole remaining callers were two integration-test fixtures, which
     switched to raw drizzle inserts, the same test-convenience-isn't-a-caller precedent phase 3a's
     `AccountsRepo.create` set). **`deps` now exposes no write method for any entity this ADR covers** —
     `TransactionsRepo` keeps only reads plus `confirm` (`confirm_transaction` was never in this ADR's scope);
     `BillsRepo` keeps only its four read methods. Coverage: unit tests on `bulk.ts`'s pure functions and on each
     aggregate importer's `StatementImportPlan` (defaulting, `flowFor` reusing the single-line flow verbatim); MCP
     integration tests for the shared-new-bill-cycle case the old dedup covered, a failing line not aborting
     sibling lines (partial success), and a line targeting an already-paid cycle erroring without aborting the
     import — plus every prior bulk-import behavior (per-item status, idempotent re-import, note-per-item)
     unchanged through the new shell path.
