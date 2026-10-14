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
engine wiring, appliers, outcomes, and the per-flow notes.

> **The engine is the external package `@rfc0/effect-runner` (ADR-031) and documents itself.** The `Persistable`
> / `PersistOutcome` / `FlowOutcome` data contract, the adapter port (`TransactionRunner`, `EntityApplier`,
> `ApplierRegistry`, `ReadBack`, `IsTransientContention`, `EngineContext`, `PublishChange`), and the engine
> semantics (one transaction per batch — an empty batch skips the transaction entirely — the version guard, the
> bounded retry loop, idempotency, `runEffectsSequence`, change publication) are specified in its
> [architecture doc](https://github.com/RafaelFCarneiro/effect-runner/blob/v0.3.0/docs/architecture.md), with its principle in its
> [FC/IS doc](https://github.com/RafaelFCarneiro/effect-runner/blob/v0.3.0/docs/functional-core-imperative-shell.md). The package docs are not in the npm tarball — read them
> on GitHub. **This file covers FinTrack's side only**: the SQLite adapter, the composition-root wiring, and the
> per-flow notes. The package's public API (every `src/index.ts` export) is semver-governed
> ([ADR 0001](https://github.com/RafaelFCarneiro/effect-runner/blob/v0.3.0/docs/adr/0001-extracted-from-fintrack.md)); a port change lands there first.

### The core's contract — what a controller returns

- **A converted controller returns `ResultAsync<{ persist: Persistable[]; response: T }, AppError>`** (not
  `ResultAsync<T>`), composed with `safeTry` as before — it just builds `Persistable`s instead of calling
  `deps.<x>.create`. Builders: `logic/persistence.ts`'s `insert`/`update`/`remove`.
- **`Persistable` / `PersistOp`** come from `@rfc0/effect-runner` (see its architecture doc for the shapes).
  Each FinTrack entity module owns its own tag constant (e.g. `models/account.ts`'s `ACCOUNT_ENTITY_TAG`).
- **`version`** — every mutable table carries `version INTEGER NOT NULL DEFAULT 0` (§ Relational schema): an
  optimistic-concurrency token, persistence-side only, never on the public model/wire shape. An `insert`
  `Persistable`'s model omits it (a new row is always `INITIAL_VERSION`, `@rfc0/effect-runner`); only
  `update`/`delete` carry the real read `version`, via the persistence-side type (`AccountEntity` = `Account`
  + `version`).
- **The managed-entity base.** Every entity's persistence-side type is built with the package's
  `withPersistenceMeta`: `XxxEntitySchema = withPersistenceMeta(XxxSchema)` adds the `version` field, so the
  token's shape is declared once, not per entity. `versionedTableApplier` (the SQLite adapter) stays in
  `diplomat/db`.
- **`idempotencyKey` — optional dedup metadata on the `insert` `Persistable` itself, not the model** (ADR-029
  Phase 2; envelope shape in the package's architecture doc). `logic/persistence.ts`'s `insert` builder accepts
  and carries it through unchanged; `TransactionSchema` carries no such field — only the wire/out read view
  does, since the key is engine bookkeeping, not a transaction business property. An entity with no idempotency
  config (dashboards, settings) never sets it.
- **The key is domain-derived, never caller-supplied** (ADR-029 Phase 2b). `logic/transaction.ts`'s
  `deriveIdempotencyKey(identity, decimals, discriminator?)` is the single derivation for every transaction
  insert — single-add (`addAccountExpense`/`addAccountIncome`/`addCardPurchase`/`createTransfer`) and bulk import
  alike, since bulk import's `flowFor` reuses those same single-line flows verbatim rather than deriving its own
  key. It hashes (`crypto.createHash('sha256')…digest('hex')`) a canonical composition of the write's full
  deterministic identity — funding source id (account or card id; `undefined` for an unattached movement),
  `counterpartyId` (a transfer's destination account; unset for a movement/purchase — omitting it would let two
  transfers sharing source/date/description/amount but different destinations collide), `billPeriodKey` (a card
  purchase's resolved `month-year` bill cycle; unset for a movement/transfer — an explicit `billMonth`/`billYear`
  override can target a different cycle than an otherwise-identical purchase, so it must be part of the identity
  too), `type`, `currency`, `date`, `normalizeMerchant`-normalized description, and the amount rounded to the
  currency's own `decimals` via `roundToDecimals` (never a raw `.toFixed`, which truncates rather than rounds at
  a float boundary like `1.005`) — plus the caller's optional `discriminator`. The canonical form is
  `JSON.stringify` of the ordered field
  array, not a plain string-joined concatenation: a caller-supplied `discriminator` is otherwise-unconstrained
  text, so concatenating it with a plain separator (even one chosen to look safe against the other, more
  constrained fields) risks two different field combinations serializing to the same string; `JSON.stringify`'s
  per-element quoting/escaping keeps every field boundary unambiguous regardless of content. Deterministic
  composition ⇒ pure ⇒ stays in `logic/` (no `randomUUID`, no clock read); a sha256 hash of a string is a pure
  computation like any other, unlike the id/clock reads that are barred from `logic/`.
  `CreateTransactionSchema`/`CreateTransferSchema` (wire/in) carry no whole-key field at all — only an optional
  `discriminator?: string`, the load-bearing escape hatch for recording a genuinely-distinct transaction that
  would otherwise derive an identical key (e.g. two identical purchases the same day). Each insert-shaped flow
  calls `deps.currencies.list()` itself to resolve `decimals` for the entity's own resolved currency, once it has
  the funding source and currency in hand; bulk import (`importAccountStatement`/`importCardStatement`) caches
  that call's promise onto the batch's `cachedDeps` the same way it already does for `deps.locale()`, so an
  N-line import performs one currency-list read, not N, while each line still independently resolves its own
  real account/card and currency (no batch-level account/decimals pre-resolution the way it used to). `recurringIdempotencyKey` (`rec-<ruleId>-<date>`, `controllers/recurring.ts`) and the
  bill-payment transfer's `billpay-<billId>` (`controllers/creditCard/bill.ts`) are unrelated, hand-built keys
  for internally-generated writes that never go through `CreateTransactionSchema` — outside this derivation.
  **One-time key-format discontinuity**: a statement re-imported after this landed won't dedup against
  pre-existing readable-format keys (possible duplicates of previously-imported rows) — accepted at personal
  scale, no backfill (old single-add keys were arbitrary caller strings with no canonical mapping to a hash).

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
- **Exception — the auth flows (ADR-033) are adapted once at the composition root.** `login`/`claimOwner`/
  `logout`/`authenticate`/`issueSetupCode`/`pruneExpiredSessions`, the CLI's `claimOwnerLocally`/`resetPassword` (`composition/cli.ts` binds its own runner the same way) and the access-token flows (`createToken`/
  `revokeToken`/`revokeSignInByHash`/`authenticateToken`, `controllers/accessTokens.ts`) and the stdio sign-in flows (`startGrant`/`approveGrant`/`denyGrant`/`redeemGrant`/`pruneExpiredGrants`, `controllers/grants.ts`) are run from several shell sites (the auth hook,
  the sign-in and token routes, startup), none of which is "the" handler, and a single batch can mix three entities
  (`claimOwner`: user + setup code + session). So `adapters/auth.ts`'s `outcomeToDb` (the five entities'
  `entityDbAdapter` pairs applied in turn — each rewrites only its own tag) is applied in `composition/auth.ts`'s
  `bindAuthRunEffects`, which wraps the shell's `RunEffects` once: `runEffects(() => flow().map(outcomeToDb))`.
  Every auth call site then holds that bound runner, never the raw one. Still exactly once, still outside
  `diplomat/db`; the controllers are unchanged (`{ persist, response }`).

### The effect runner — FinTrack's wiring

The engine's behavior (retry, version guard, idempotency, empty batches, `runEffectsSequence`, change publication
and its failure isolation) is the package's to document — see the pointer above. FinTrack only does the following:

- **Composition-root binding** (`composition/runtime.ts`, `test/integration/app-builder.ts`). The `EngineContext` is bound to the
  SQLite adapter and FinTrack's own error: `diplomat/db/driver.ts`'s `createTransactionRunner(db)` is `runner`,
  `diplomat/db/sqliteErrors.ts`'s `isSqliteBusy` is `isTransientContention` (`SQLITE_BUSY` and
  `SQLITE_BUSY_SNAPSHOT`, matched on the driver error's base `.code`; `busy_timeout` in `driver.ts` absorbs the
  common case, ADR-024), and `() => conflict` (`models/error.ts`) is `conflictError`. `E` is `AppError`.
- **The `ApplierRegistry`** is assembled once there, one `EntityApplier` per FinTrack entity tag.
- **Typed `Tx`.** `diplomat/db/effects.ts` re-exports the package's `EntityApplier`/`ApplierRegistry`/`ReadBack`
  specialized with FinTrack's own `Tx`.
- **Change bus.** `composition/runtime.ts` builds one `UserChangeBus` (`composition/changeBus.ts`) and gives each
  runner a `publish` bound to its user — the engine's post-commit hook becomes `(entities) => bus.publish({ userId,
  entities })` — so every event says whose change it is (`null` for the identity runner). It hands `changeBus.subscribe`
  to the HTTP sidecar (SSE, `docs/ui.md`, which forwards only the stream's own user's events), and wires one shared
  stderr reporter (`reportChangeError`) as both the bus `onError` and the context's `onPublishError`. stderr only —
  stdout carries the stdio MCP protocol (ADR-007).
- **One runner per request, per user (ADR-033 §5).** `runtime.runEffectsFor(principal)` /
  `runEffectsSequenceFor(principal)` run the engine with an applier registry built for `principal.userId`
  (`applierRegistryFor`): nothing is bound once and shared. The identity flows use `runtime.authRunEffects`
  (`AUTH_APPLIERS` only), the one runner with no user.
- **`runEffectsSequence` use.** Bulk import (`importAccountStatement`/`importCardStatement`) runs its lines through
  it and reuses the single-line flows verbatim.
- **`RunEffects` is shell-only, never a field on `Deps`.** `controllers/deps.ts` exports the type, but only the
  `diplomat/mcp`/`diplomat/http` handlers hold an instance — a controller cannot reach it to apply its own
  writes. The handler gets it, with the caller's `Deps`, from `Scoped` (`scopedFor(tenancy, principal)`).
  `resetLocale` (`diplomat/db/localeCache.ts`, keyed by user) is part of `Scoped` too, used by the one handler that
  needs it (`set_locale`), called only after the write commits.

### Scoped appliers (ADR-033 §5)

Every applier of an owned entity is built for one user — `ownedTableApplier(table, userId)` (`diplomat/db/effects.ts`),
exported by each repo as `xApplier(userId)`. Appliers still decide nothing and read nothing about the domain; what the
scope adds is mechanical:

- **insert** stamps `user_id` with the runner's user (a `userId` on the model is discarded — a flow cannot choose an
  owner), and an idempotent insert conflicts on `(user_id, idempotency_key)`; the surviving-row read is scoped too;
- **update / delete** add `AND user_id = :me`, and an update never rewrites `user_id`. Another user's row — and a shared
  default, whose `user_id` is NULL — does not match, so the write fails exactly like a stale version
  (`VersionConflict`, three attempts, then `conflict`);
- hand-written appliers follow the same rule: `userSettingsApplier` (keyed by `user_id`, no `id`),
  `merchantCategoryApplier` (writes only the user's `history` edge, conflicting only among their own edges),
  `transactionTagApplier` (the transaction and every tag must be the user's, else a no-op `applied: false`);
- reference data with no owner (`merchantApplier`, `currencyRateApplier`) is registered as it is.

The friendly refusals (`"default categories can't be changed"`) are the controllers', before any effect; the appliers are
the second line. `test/integration/tenancy/scopedWrites.test.ts` pins it.

### Appliers — the mechanical write

- **The invariant (ADR-023): an applier decides nothing and performs no reads at all.** Every value it persists
  was chosen by the core; every entity it touches was named by the core. Grep-able proxy: **an applier writes
  exactly one table** (the proxy is not the rule — a single-table applier could still smuggle in a decision or a
  read). All registered appliers satisfy it.
- **`versionedTableApplier(table, { readBack? })`** (`diplomat/db/effects.ts`) builds a complete `EntityApplier`
  from a drizzle table for any `id`+`version` table — `accountApplier` is `versionedTableApplier(accounts)`;
  `transactionApplier` adds a `readBack`. It writes the next version computed in application code (never a
  SQL-side `version + 1`) guarded by `WHERE id = ? AND version = ?`. Dedup is by convention: the applier uses the
  table's fixed `idempotencyKey` column when it exists (only `transactions` today): the key is merged onto the row,
  the insert conflict-targets that column, and a duplicate no-ops with `applied: false` while a generic key lookup
  (`findSurvivingRowId`) resolves the surviving row for `readBack`. A key-less insert falls back to the id-scoped
  `onConflictDoNothing` (a structural same-id guard, not idempotency). Tables outside the `id`/
  `version` convention (`merchants`, `merchant_category`, `transaction_tags`) hand-write their `EntityApplier`.
- **FK violation on a versioned `delete` → `VersionConflict`.** A row acquiring a referrer between the flow's
  read and its apply is the same "world changed" race a stale version reports; `versionedTableApplier` catches
  `isForeignKeyConstraintViolation` (`diplomat/db/sqliteErrors.ts`) and rethrows `VersionConflict` so the flow
  retries. (Rationale: ADR-021.)
- **Secondary-`UNIQUE` appliers.** `billApplier` (`diplomat/db/repos/bills.ts`; a bill is created by
  upsert-on-cycle, `UNIQUE(creditCardId, month, year)`), `tagApplier` (`tags.name`), `dashboardApplier`
  (`dashboards.name`), and `budgetApplier` (`UNIQUE(category_id, currency, period)`) wrap `insert` so an
  `isUniqueConstraintViolation` is rethrown as `VersionConflict` and the flow retries; the retry's own domain
  check then returns the clean error (`duplicate_name`, `duplicate_budget`) or touches the winning row.
  `dashboardApplier.update` wraps it too (a rename can collide). `update`/`delete` otherwise stay plain.
  `currencyRateApplier` (`UNIQUE(from_code, to_code)`) has the opposite outcome: `set_exchange_rate` is
  upsert-latest, so a concurrent first insert retries into an **update** and both callers succeed. (Rationale:
  ADR-021.)
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

- **Auth entities** (`user`, `session`, `setup_code`, `access_token`, `client_grant`;
  `diplomat/db/repos/{users,sessions,setupCodes,accessTokens,clientGrants}.ts`). `userApplier`, `sessionApplier`,
  and `accessTokenApplier` are plain `versionedTableApplier`s. `clientGrantApplier` is one too, except that its `insert`
  rethrows a unique-constraint violation as `VersionConflict`: `user_code` is unique among PENDING grants (a partial index),
  so two requests drawing the same free code at once collide there, and the retry re-runs `startGrant`, whose
  `freshUserCode` sees the committed row and draws another code (the shape `tagApplier` uses for `tags.name`).
  `setupCodeApplier` wraps `insert` the way
  `settingsApplier` does: `setup_codes` holds ONE fixed row (`SETUP_CODE_ID`), so an id collision on insert is the
  concurrent-first-issue race — it is rethrown as `VersionConflict` and the retry updates the winner's row in place
  rather than silently no-oping (a lost insert would leave a process printing a code that was never stored).
  `claimOwner` emits only an owner `update`, a setup-code `update` (consumed) and a session `insert` — never a user
  `insert`; the CLI's `claimOwnerLocally` emits the same owner `update` (one shared `claimedOwner`) plus a consuming setup-code `update`
  only when a code is still outstanding, and no session; `resetPassword` emits the user's hash `update`, a session `delete` per
  session of that user and a `revoked_at` `update` per live access token of that user, in one batch; `authenticate` writes nothing unless the session is stale (`SESSION_TOUCH_INTERVAL_MS`) or must be
  deleted. The token flows: `createToken` emits one `access_token` `insert` (hash + display prefix; the plaintext
  exists only in the flow's response), `revokeToken` one version-guarded `update` setting `revoked_at` (nothing when
  already revoked — idempotent), and `authenticateToken` writes nothing unless `last_used_at` is stale
  (`SESSION_TOUCH_INTERVAL_MS`); a concurrent touch loses the version race and the retry re-reads a fresh row.
  The stdio sign-in flows (ADR-034): `startGrant` emits one `client_grant` `insert` (hashes only; the device code is in the
  response); `approveGrant`/`denyGrant` one version-guarded `update` of the pending grant (approval writes the approver, scopes,
  duration and `approved_at`); `redeemGrant` emits, for an approved grant, an `access_token` `insert` (`kind: stdio`) **and** the
  grant's `redeemed` `update` in ONE batch — the version guard on that `update` is what makes the device code single-use: a
  second redeem built from the same stale read cannot commit, and the engine's retry re-reads a spent grant — plus, for an
  approved grant past its window, the `expired` `update` that settles it (terminal, written once); `pruneExpiredGrants` one
  `delete` per unredeemed grant past its window and per redeemed grant superseded by a newer approval for the same user, profile and client (never a live pending/approved one, never the newest redeemed per key).

### Outcomes and responses

- **`PersistOutcome`** is the package's per-`Persistable` report (`applied`, `read`, `entity` — see its
  architecture doc). A `FlowOutcome.response` is normally the plain core-derived value; an idempotency-aware flow
  instead returns a **pure, sync** function of `PersistOutcome[]` (`response` never performs I/O — rule 1). First
  users: `add_account_expense`/`add_account_income`/`create_transfer`'s `created` flag; bulk import reuses the
  same contract per item. Response-shaping helpers live in `logic/transaction.ts` (`viewFromOutcome`;
  `buildUpsertResult` → `UpsertTransactionResult` / `ClassifiedUpsertResult`), `purry`'d so that e.g.
  `buildUpsertResult(classification, locale)` **is** the `(outcomes) => T` a flow assigns directly.
- **Outcomes are addressed by entity tag, never by batch position** (ADR-023): `logic/persistence.ts`'s
  `outcomeFor(tag, outcomes)` (asserting exactly one match) — needed because a merchant insert is *prepended*
  ahead of the transaction that FKs it. Exception: `applyDueRecurring` slices `outcomes`
  positionally (`R.zip`), safe because nothing is ever prepended ahead of its transaction inserts.
- **Idempotency key placement** (ADR-023 decision 4, ADR-029). The key rides the `insert` `Persistable`'s own
  optional `idempotencyKey` — envelope metadata, never a field of the domain model (`TransactionSchema` doesn't
  carry it). `logic/persistence.ts`'s `insert` builder and every flow that mints one
  (`add_account_expense`/`add_account_income`/`add_card_purchase`/`create_transfer`, `pay_bill`'s transfer,
  `apply_due_recurring`, and bulk-import lines reusing the single-line flows) set it alongside `model`.
  Read-first-dedup entities (dashboards, settings) carry none. A table that physically has the `idempotencyKey`
  column is a promise every insert into it keeps: `versionedTableApplier.insert` rejects a keyless insert (and a
  keyed insert into a table without the column) up front rather than surfacing an opaque `NOT NULL` violation.
- **The `readBack` deviation** (ADR-023 decision 4; the `ReadBack` type is the package's). An entity may register
  a post-write projection — `transactions` reads the display-joined view via `fetchTx` — landing on
  `PersistOutcome.read`. This is a projection read executed **inside the engine's unit of work**, **capped at one
  hook**, and is *not* sanctioned by FC/IS (rule 6 permits an outcome-dependent response, not an in-engine
  read) — recorded here as the project's deliberate deviation. A second such hook is the signal to switch to ADR-023 option D (the core builds the full
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
- **Budgets** (`controllers/budgets.ts`, Feature Design 015 phase 1). `createBudget` resolves the target by name
  (`resolveCategoryRef`/`resolveSubCategoryRef`, `controllers/resolve.ts` — the same resolvers transactions
  resolve through), guards it is expense-eligible and not a duplicate `(category_id, currency, period)`, and
  mints an `insert`. `updateBudget` is a version-guarded rewrite of `limit`/`period` (a `budgetsRepo.findById`
  read); a patch that changes nothing is a no-op (empty `persist`, same idiom as `updateAccount`). `deleteBudget`
  is idempotent-by-design like `deleteTag` — a missing id returns `{ deleted: false }` on an empty batch.
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
  future `date` edit. `entityFromExisting` (`logic/transaction.ts`) is the `RawTransactionView` →
  `TransactionEntity` field mapping confirm already inlined before this phase, extracted as a pure logic
  function — not a controller-local helper, since it's a plain data transform with no I/O — so the
  `amount`/`date`/`status` overrides on top of it read as the diff they are.
- **Recurring** (Feature Design 017 adds the merchant). `createRecurring` resolves `merchantKey`: an explicit
  `merchant` (normalized, stored as-is — no candidate lookup, since the user is naming it directly); otherwise it
  mirrors `planAccountMovement`'s own precedence — `deps.merchants.matchCandidates(normalizedDescription)` +
  `pickClassification` first, reusing an already-learned `merchant_category` key so the rule reinforces the same
  merchant identity a matching transaction would, falling back to the normalized `description` (empty-string
  guarded) only when nothing matches. Either way the key is emitted via `withMerchant` — a `MERCHANT_ENTITY_TAG`
  insert *prepended* ahead of the rule insert (rule 5, composition), same pattern transactions use.
  `applyDueRecurring` reads every due rule, computes each rule's occurrences
  (bounded `MAX_RECURRING_OCCURRENCES_PER_RUN = 36`) and `nextDue` in the domain, and emits **one atomic batch** —
  every occurrence (`TRANSACTION_ENTITY_TAG` insert, `refs.merchantKey` copied straight from the rule — the
  `merchants` row already exists from rule creation, so materialization emits no merchant `Persistable` of its
  own, preserving the positional-`R.zip` exception above) plus each rule's version-guarded `advance` — retried
  whole on any conflict, safe because `rec-<ruleId>-<date>` idempotency keys make re-materialization a no-op. A
  deliberate atomicity granularity, in contrast to bulk import.
- **Bulk import** (ADR-022) — a **sequence of independent units** (partial success): one bad or conflicting line
  must not roll back the rest. `import_card_statement`/`import_account_statement` default each line via `bulk.ts`
  and return a `StatementImportPlan` (lines + a `flowFor` binding each line to the aggregate's own single-line
  flow — `addCardPurchase`, or `addAccountExpense`/`addAccountIncome` by the line's `type` — unchanged); the
  handler runs it through `runEffectsSequence` and shapes the `SequenceOutcome[]` into `BulkResult` (`bulk.ts`'s
  `buildBulkResult`; `needs_review` from each line's own classification confidence). No within-batch cycle dedup —
  line *i+1* reads the bill line *i* just committed.
- **No more batch-level currency pre-resolution** (superseded by ADR-029 Phase 2b — was ADR-026 Phase 1b).
  `importCardStatement`/`importAccountStatement` used to resolve the account/card ref and `deps.currencies.list()`
  once for the whole batch purely to round each line's idempotency key to the right precision. Now that the key
  is derived inside `addCardPurchase`/`addAccountExpense`/`addAccountIncome` themselves (each `flowFor` line just
  calls those same single-line flows), each line resolves its own real card/account, currency, and decimals
  independently — no pre-plan step, and the batch-level `CurrencyCode.enum.USD` fallback (and the known gap it
  had: an unattached statement's per-item currency override wasn't consulted for it) is gone along with it. An
  unattached statement's per-item `currency` now correctly drives that line's own decimals rounding.
- **Merchant key is always stored, matched or not** (`planAccountMovement`): when classification found no
  merchant, it falls back to `normalizeMerchant(description)` (empty-string guarded) so a later category
  correction (`resolveMerchantCorrection`) has a merchant to attach to. `add_card_purchase` still lacks this
