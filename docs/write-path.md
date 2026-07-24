# Write path: functional core / imperative shell (as built)

> **Project-specific, load-on-demand.** This is the full as-built mechanics of the write path — read it before
> writing or changing write-path code. It is *not* a canonical/agnostic doc: it names concrete entities, tables,
> and identifiers, and it may reference ADRs. The always-loaded **guardrails** (the few rules any change must
> respect) live in `docs/architecture.md` § Write path; the **rationale and migration history** live in
> **ADR-021** (functional core / imperative shell), **ADR-022** (the effect runner), and **ADR-023** (appliers
> decide nothing). Keep this file current-only, like `docs/architecture.md`.

Every write flow is converted. `deps` exposes **no write method at all** — controllers only decide and return
effects; the domain is structurally incapable of writing.

Per `docs/functional-core-imperative-shell.md`: a controller **decides** and returns the write as data; the
diplomat shell **applies** it. Organized below by concern — the core's contract, the boundary adaptation, the
effect runner, appliers, outcomes, and the per-flow notes.

### The core's contract — what a controller returns

- **A converted controller returns `ResultAsync<{ persist: Persistable[]; response: T }, AppError>`** (not
  `ResultAsync<T>`), composed with `safeTry` as before — it just builds `Persistable`s instead of calling
  `deps.<x>.create`. Builders: `logic/persistence.ts`'s `insert`/`update`/`remove`.
- **`Persistable` / `PersistOp`** (`models/persistable.ts`) are **entity-agnostic** — `Persistable<Tag, Model>`
  generic over the entity's own tag + model, never a closed union; this file never imports a specific entity.
  `PersistOp` is a named enum (`insert`/`update`/`delete`). Each entity module owns its own tag constant
  (e.g. `models/account.ts`'s `ACCOUNT_ENTITY_TAG`).
- **`version`** — every mutable table carries `version INTEGER NOT NULL DEFAULT 0` (§ Relational schema): an
  optimistic-concurrency token, persistence-side only, never on the public model/wire shape. An `insert`
  `Persistable`'s model omits it (a new row is always `INITIAL_VERSION`, `models/persistable.ts`); only
  `update`/`delete` carry the real read `version`, via the persistence-side type (`AccountEntity` = `Account`
  + `version`).

### From model to row — the boundary adaptation

- **Model→row adaptation happens once, at the diplomat handler — never inside `diplomat/db`.** A `Persistable`
  carries domain models; the MCP/REST handler maps the controller's `FlowOutcome` through the entity's own
  `outcomeToDb` *before* calling `runEffects` — e.g. `createAccount(deps, model).map(accountAdapters.outcomeToDb)`.
  `runEffects(flow)` still takes one argument.
- **`entityDbAdapter(entityTag, modelToDb)`** (`logic/persistence.ts`) builds an entity's `persistableToDb`/
  `outcomeToDb` pair from just its `modelToDb`, so each adapter module is one line; an entity whose model matches
  its row 1:1 (`tags`) supplies the identity `modelToDb`. Exception: `adapters/bills.ts` hand-writes its own,
  because a bill `update` needs `paymentTransactionId: undefined` (leave the column unchanged) to differ from
  `null` (clear it) — an asymmetry the uniform factory can't express.

### The effect runner — the engine

- **`runEffects(db, registry, flow)`** (`diplomat/db/effects.ts` — the only place that touches `Db` for a
  converted flow) invokes `flow` and executes the effects it returns. **Single-atomic-unit** mode: the `persist`
  batch applied in one `db.transaction`, each row-shaped `Persistable` dispatched by `p.entity` through the
  `registry`; **response** always produced; message dispatch is a named-but-unbuilt future effect kind.
  `update`/`delete` apply `... SET ..., version = <read version + 1> WHERE id = ? AND version = ?` — the new
  version computed in application code, **never** a SQL-side `version + 1`. A version-guarded op affecting zero
  rows rolls back the whole batch and re-invokes `flow` (fresh read → fresh decision), bounded, then surfaces
  the generic `conflict` `AppError` (`models/error.ts`, no business payload).
- **`runEffectsSequence(db, registry, items, flowFor)`** — the second mode: each item's flow (built by `flowFor`,
  invoked only when the runner reaches it) runs through the same `attempt`/retry primitive, in its **own
  transaction**, in order. Item *i+1* sees item *i*'s committed writes — which is why bulk import reuses the
  single-line flows verbatim. A unit's version conflict retries only that unit; a domain error or exhausted
  retries is recorded as `Err` and the sequence **continues** (partial success). Returns one `SequenceOutcome<T>`
  (`Result<T, AppError>`) per item, positionally parallel to `items`.
- **`EntityApplier` / `ApplierRegistry`** (`diplomat/db/effects.ts`) — the engine dispatches a row-shaped
  `Persistable` to `registry[p.entity]`; it never names an entity and never needs a new `case` as entities
  convert. The `ApplierRegistry` is assembled once at the composition root (`main.ts`,
  `test/integration/app-builder.ts`).
- **`RunEffects` is shell-only, never a field on `Deps`.** `controllers/deps.ts` exports the type, but only the
  `diplomat/mcp`/`diplomat/http` handlers hold an instance — a controller cannot reach it to apply its own
  writes. `resetLocale` (locale-cache invalidation, `diplomat/db/localeCache.ts`) is threaded the same shell-only
  way to the one handler that needs it (`set_locale`), called only after the write commits — infrastructure
  bookkeeping attached to a write, not a domain-declared effect.

### Appliers — the mechanical write

- **The invariant (ADR-023): an applier decides nothing and performs no reads at all.** Every value it persists
  was chosen by the core; every entity it touches was named by the core. Grep-able proxy: **an applier writes
  exactly one table** (the proxy is not the rule — a single-table applier could still smuggle in a decision or a
  read). All registered appliers satisfy it.
- **`versionedTableApplier(table, { idempotencyColumn?, readBack? })`** (`diplomat/db/effects.ts`) builds a
  complete `EntityApplier` from a drizzle table for any `id`+`version` table — `accountApplier` is
  `versionedTableApplier(accounts)`; `transactionApplier` is
  `versionedTableApplier(transactions, { idempotencyColumn: 'idempotencyKey', readBack })` (ADR-023: the
  once-bespoke applier collapsed to a registration). Tables outside the `id`/`version` convention hand-write
  their own `EntityApplier` against the same interface: the `id`/`version`-less `merchants`, `merchant_category`,
  `transaction_tags`. `dashboards` used to key on `name` itself and hand-write its applier this way too; Feature
  Design 013 Phase 1 normalized it to `id`/`version` with `name UNIQUE`, moving it into the
  versioned-entity-with-unique-secondary-key family below instead.
- **FK violation on a versioned `delete` → `VersionConflict`.** A row acquiring a referrer between the flow's
  read and its apply is the same "world changed" race a stale version reports; `versionedTableApplier` catches
  `isForeignKeyConstraintViolation` (`diplomat/db/sqliteErrors.ts`) and rethrows `VersionConflict` so the flow
  retries. (Rationale: ADR-021.)
- **`billApplier`** (`diplomat/db/repos/bills.ts`) — `update`/`delete` are plain `versionedTableApplier`, but a
  bill is *created* by upsert-on-cycle (`UNIQUE(creditCardId, month, year)`), not by `id`, so the id-scoped
  `onConflictDoNothing` doesn't swallow a same-cycle race; `billApplier` rethrows the
  `isUniqueConstraintViolation` (`diplomat/db/sqliteErrors.ts`) as `VersionConflict` and the flow retries,
  touching the winning cycle. `tagApplier` mirrors this exactly for `tags.name`'s `UNIQUE` (retry → the domain's
  own name check returns `duplicate_name`). `dashboardApplier` (`diplomat/db/repos/dashboards.ts`) is the same
  wrapper again for `dashboards.name`'s `UNIQUE` (Feature Design 013 Phase 1 — `dashboards` used to key on `name`
  itself and hand-write its own `EntityApplier`; normalizing to a surrogate `id` PK with `name UNIQUE` let it
  join this family instead): a concurrent first save of a brand-new name mints two ids, both insert, and the
  second's `SQLITE_CONSTRAINT_UNIQUE` retries the same way. (Rationale: ADR-021.)
- **The `merchant` entity** — key-only, hand-written `merchantApplier` (insert-only, `onConflictDoNothing`).
  Every flow whose decision implies a merchant emits its own `MERCHANT_ENTITY_TAG` `Persistable` ahead of
  whatever references it, via `logic/merchant.ts`'s `withMerchant` (transaction inserts) and
  `withMerchantLearning` (learning edges) — neither `transactionApplier` nor `merchantCategoryApplier` creates a
  merchant row anymore. `merchantCategoryApplier` (`MERCHANT_CATEGORY_ENTITY_TAG`) is single-table:
  `MerchantCategoryEdge` carries `weightDelta`/`origin` (`MerchantOrigin = Extract<ClassificationMethod, 'rule' |
  'history'>`) chosen by `resolveMerchantCorrection`; the applier applies `weight: weightDelta`/`origin` on
  insert and `weight = weight + weightDelta` on conflict, never touching `origin` on the conflict path
  (ADR-023 decision 2).
- **The `transactionTag` entity** — hand-written `transactionTagApplier` (`diplomat/db/repos/transactionTags.ts`):
  no `id`/`version`, a **set-replace** addressed by the flow's own transaction id, zero reads. The core resolves
  names → ids in `logic/tag.ts`'s `resolveTagIds` (matches `input.tags` against `deps.tags.list()`, silently
  dropping misses — leniency by decision, with a test). `controllers/resolve.ts`'s `resolveTagLinks` builds the
  `TRANSACTION_TAG_ENTITY_TAG` `Persistable`: `input.tags` omitted → `null` (no read, no `Persistable`, existing
  tags untouched); provided (even `[]`) → appended after the transaction `Persistable` (its FK needs the
  transactions row). **Duplicate-replay is a no-op**: on a duplicate idempotency key the transaction insert
  no-ops, the tag set's FK miss becomes `applied: false`, and the surviving row's tags are left alone
  (first-write-wins). Because `readBack` runs before the tag set applies, each flow overlays `resolveTagLinks`'
  matched names via `logic/tag.ts`'s `overlayResolvedTags`, gated on the **tag set's own** outcome
  (`outcomeFor(TRANSACTION_TAG_ENTITY_TAG, outcomes).applied`) — not the transaction's. (Full reasoning:
  ADR-023 decision 3 / step 3.)

### Outcomes and responses

- **`PersistOutcome`** (`models/persistable.ts`) — what the shell reports per `Persistable`: `applied` (did the
  insert land, or no-op as an idempotent duplicate), the entity's already-decoded `read` of what is now
  persisted, and the `entity` tag. A `FlowOutcome.response` is normally the plain core-derived value; an
  idempotency-aware flow instead returns a **pure, sync** function of `PersistOutcome[]` that `runEffects` calls
  once applied (`response` never performs I/O — rule 1). First users: `add_account_expense`/`add_account_income`/
  `create_transfer`'s `created` flag; bulk import reuses the same contract per item. Response-shaping helpers
  live in `logic/transaction.ts` (`viewFromOutcome`; `buildUpsertResult` → `UpsertTransactionResult` /
  `ClassifiedUpsertResult`), `purry`'d so that e.g. `buildUpsertResult(classification, locale)` **is** the
  `(outcomes) => T` a flow assigns directly.
- **Outcomes are addressed by entity tag, never by batch position** (ADR-023). `applyPersistable` stamps each
  outcome with its source `entity`; `logic/persistence.ts`'s `outcomeFor(tag, outcomes)` (asserting exactly one
  match) finds a flow's own outcome regardless of batch position — needed because a merchant insert is
  *prepended* ahead of the transaction that FKs it. Exception: `applyDueRecurring` slices `outcomes`
  positionally (`R.zip`), safe because nothing is ever prepended ahead of its transaction inserts.
- **The generic idempotency treatment** (ADR-023 decision 4). Registration-declared (`idempotencyColumn`), never
  per-applier code: when a row carries a value there, `insert` conflict-targets that column, a duplicate no-ops
  with `applied: false`, and the engine resolves which row survived (one generic `SELECT id … WHERE <column> = ?`)
  so `readBack` reads the persisted row. Distinct from the id-scoped `onConflictDoNothing({ target: table.id })`
  a key-less insert falls back to (a structural same-id guard, not idempotency). The key rides on entity models
  as an ordinary column today; its honest home is the `Persistable` envelope
  ([#134](https://github.com/RafaelFCarneiro/fintrack/issues/134)).
- **The `readBack` deviation** (ADR-023 decision 4). An entity may register a post-write projection —
  `transactions` reads the display-joined view via `fetchTx` — landing on `PersistOutcome.read`. This is a
  projection read executed **inside the engine**, **capped at one hook**, and is *not* sanctioned by FC/IS
  (rule 6 permits an outcome-dependent response, not an in-engine read) — recorded here as the project's
  deliberate deviation. A second such hook is the signal to switch to ADR-023 option D (the core builds the full
  response itself).

### Per-flow notes

- **Simple CRUD.** `update_account`/`delete_account` reuse `accountApplier` (just a version-carrying read,
  `accountsRepo.findRawById`). `categoryApplier` (shared by category and sub-category, one `CATEGORY_ENTITY_TAG`)
  and `recurringRuleApplier` are plain `versionedTableApplier`. `deleteTag`/`deleteAccountTransaction`/
  `deleteDashboard` are idempotent-by-design: a missing id (or, for `deleteDashboard`, name — resolved to an id
  via `findRefByName`) returns `{ deleted: false }` on an empty `persist` batch, no write. `renameDashboard`
  is a version-guarded rewrite of the whole row under a new `name`, same `id` — its own `duplicate_name`
  pre-check is the fast path, but it's the first flow whose `update` changes `dashboards.name` to a value it
  doesn't already hold, so `dashboardApplier.update` also wraps `isUniqueConstraintViolation` into
  `VersionConflict` (the same treatment `insert` already had), and the retry's own pre-check is what turns
  that into a clean `duplicate_name` rather than an uncaught exception. A same-name rename is a no-op (empty
  `persist`), skipping the guard entirely — renaming something to what it's already called can't collide.
- **Cascades live in the schema or the domain, never the applier.** `merchant_category.category_id` and
  `transaction_tags.transaction_id` are `ON DELETE CASCADE` in the schema (association rows with no independent
  meaning once their owner is gone). The credit-card cascade is a **domain decision**: `deleteCreditCard`
  (`controllers/creditCard/creditCard.ts`) reads every correlated bill and transaction (`billsRepo.findAllByCard`,
  `transactionsRepo.findAllCorrelatedToCard` — the `correlatedToCard` predicate lives in the transactions repo,
  reused by `creditCardsRepo.countCorrelated`) and emits their `Persistable`s in FK-safe order:
  `[...bill payment-clears, ...transaction removals, ...bill removals, remove creditCard, remove account]`. A bill
  this batch already cleared is removed at `bill.version + 1` (the version the shell will have bumped it to by the
  time that delete applies). `createCreditCard` is the mirror two-entity insert `[account, creditCard]`.
  (History — why the applier no longer cascades: ADR-021 / ADR-023.)
- **`updateCreditCard`** (`controllers/creditCard/creditCard.ts`, Feature Design 014 phase C, mirrors
  `updateAccount`) — a rename (`newName`) is a two-entity `update` batch, `[account, creditCard]` (same order as
  `createCreditCard`'s insert): the card's internal account is re-read via `accountsRepo.findRawById` and re-emitted
  under `Card: {newName}`, alongside the card's own version-guarded update. A non-rename update (`limit`/
  `closingDay`/`dueDay`/`paymentAccount` only) emits just the card update; an update that changes nothing emits an
  empty `persist` (`R.isDeepEqual` against the freshly-read entity, same idiom as `updateAccount`). The
  account-name-availability guard only runs for a genuine (more-than-case-only) rename — `logic/creditCard.ts`'s
  `isCardRename` type-predicate decides this the same way `updateAccount` already does for the card's own name —
  because a case-only rename's target internal-account name always case-insensitively matches the account's
  *own* current name, and would otherwise self-collide against itself in `findByName`.
- **`payBill`/`revertBillPayment`** (`controllers/creditCard/bill.ts`) — plain `response` (both mint and read
  everything the response needs before building the batch). FK direction reverses the batch order between them:
  `payBill`'s positive-total batch = `[transfer insert, bill update]` (the bill points `payment_transaction_id`
  at the transfer; a non-positive total has no transfer, so the batch is just `[bill update]`);
  `revertBillPayment` = `[bill update clearing the pointer, transfer remove]`. `BillEntity.paymentTransactionId`
  distinguishes `undefined` (leave unchanged) from `null` (clear). `BillsRepo` is read-only like every repo.
- **`confirmTransaction`** (`controllers/transaction/core.ts`, Feature Design 014 phase B) now routes an edit
  (`amount`/`date`) plus the status flip through a single version-guarded `update`, instead of hand-rebuilding the
  entity with only `status` overridden. It stays a thin core flow, not a delegation to
  `updateAccountTransaction`/`updateCardTransaction` — this module must never import the aggregates (dependency
  table), so their guards (`assertAccountOwnedLegs`, `guardTransferMutability`, the bill-payment block) are
  unreachable from here. Immutability is enforced directly instead, via the core-visible `isTransfer`
  (`logic/transaction.ts`, `type === 'transfer'`, ADR-002): an edit is rejected when the transaction is a
  transfer or bill-payment (`transactionErrors.confirmEditNotAllowedForTransfer`), but a plain status-only
  confirm of one still goes through — this is marginally stricter than `update_account_transaction` (which
  permits editing a *regular* transfer's amount), a deliberate trade documented in the design rather than a gap.
  The future-date guard (`transactionErrors.cannotConfirmFutureDated`, invariant 20 in `docs/architecture.md`)
  resolves `date` as `input.date ?? existing.date` and applies unconditionally — so a plain confirm (no edit at
  all) of a transaction whose *existing* date already sits in the future is rejected too, not only an explicit
  future `date` edit. `entityFromExisting` (a tiny local, not exported) is the `RawTransactionView` →
  `TransactionEntity` field mapping confirm already inlined before this phase, extracted so the
  `amount`/`date`/`status` overrides on top of it read as the diff they are.
- **Recurring.** `applyDueRecurring` reads every due rule, computes each rule's occurrences (bounded
  `MAX_RECURRING_OCCURRENCES_PER_RUN = 36`) and `nextDue` in the domain, and emits **one atomic batch** — every
  occurrence (`TRANSACTION_ENTITY_TAG` insert) plus each rule's version-guarded `advance` — retried whole on any
  conflict, safe because `rec-<ruleId>-<date>` idempotency keys make re-materialization a no-op. A deliberate
  atomicity granularity, in contrast to bulk import.
- **Bulk import** (ADR-022) — a **sequence of independent units** (partial success): one bad or conflicting line
  must not roll back the rest. `import_card_statement`/`import_account_statement` default each line via `bulk.ts`
  and return a `StatementImportPlan` (lines + a `flowFor` binding each line to the aggregate's own single-line
  flow — `addCardPurchase`, or `addAccountExpense`/`addAccountIncome` by the line's `type` — unchanged); the
  handler runs it through `runEffectsSequence` and shapes the `SequenceOutcome[]` into `BulkResult` (`bulk.ts`'s
  `buildBulkResult`; `needs_review` from each line's own classification confidence). No within-batch cycle dedup —
  line *i+1* reads the bill line *i* just committed.
- **Merchant key is always stored, matched or not** (`planAccountMovement`): when classification found no
  merchant, it falls back to `normalizeMerchant(description)` (empty-string guarded) so a later category
  correction (`resolveMerchantCorrection`) has a merchant to attach to. `add_card_purchase` still lacks this
