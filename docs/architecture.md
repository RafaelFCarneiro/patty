# FinTrack v2 — Architecture (as built)

> **This file describes the system as it IS.** Update it in the same change that alters architecture.
> Roadmap and vision: `docs/PLAN.md`. Decisions + rationale: `docs/adr/`. Agent instructions: `CLAUDE.md`.
> Layer concepts: `docs/diplomatic-architecture.md` (where the layers are) and
> `docs/functional-core-imperative-shell.md` (what crosses the write-path boundary between them — ADR-021,
> mandatory reading alongside the Diplomat doc for any write-flow change).
> Write-path mechanics: `docs/write-path.md`. Browser `/ui` surface: `docs/ui.md`.

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
7. **Read-side cross-aggregate correlation lives in controllers, not repos (ADR-028).** A repo queries only its own aggregate's table, including aggregations over that aggregate's own dimensions (ADR-011 still governs how the SQL itself is composed) — it never `JOIN`s another aggregate's table to correlate or measure it. A repo may still `LEFT JOIN` a reference table purely to fetch a label (e.g. a category's `name`/`names` for display) — the test is whether the repo is encoding another aggregate's business rule or matching two aggregates' rows (governed, move to the controller) versus merely resolving a foreign key's display label (acceptable). When two aggregates' data must be correlated, each repo returns its own read and the **controller** fetches both, handing them to **`logic/`** to correlate and shape the response — the matching rule is pure, unit-testable domain code, not SQL. Transaction "what counts" predicates (effective/pending/committed/expense/non-transfer) are single-sourced as named composable fragments (`diplomat/db/queries/txPredicates.ts`) rather than re-authored as raw SQL per repo. **Query-composition helpers live in `diplomat/db/queries/`** (`txPredicates.ts`, `filters.ts`, `transactionSelect.ts`, `aggregateWhitelist.ts`, `fts.ts`) — the one place to audit what SQL-shaping machinery exists outside `repos/`'s own per-aggregate queries, distinct from `diplomat/db`'s infra plumbing (`driver.ts`, `effects.ts`, `schema.ts`, …). This groups the *shared* composition helpers; it does not by itself capture every raw join/WHERE still authored inline inside a `repos/*.ts` file — auditing that inline SQL is a separate, ongoing exercise.

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
| `diplomat/db`, `diplomat/http` → `diplomat/changeBus.ts` | **Documented exception (ADR-027 Phase 3)**: `changeBus.ts` sits at the `diplomat/` root, owned by neither submodule — shared plumbing between the effect runner's post-commit publish (`diplomat/db/effects.ts`) and the SSE subscriber (`diplomat/http/routes/ui.ts`). Both imports are **type-only** (`PublishChange`/`ChangeBus`); the concrete `createChangeBus()` constructor is called exactly once, at the composition root (`main.ts`), which is the only caller that ever wires the two submodules together — this row documents a shared-type import, not composition-root wiring leaking into `diplomat/*`. |
| `controllers/transaction/{core,read,bulk}.ts` | **Narrower than `controllers/` above (ADR-016)**: same base rule, but additionally must NOT import `logic/bill.js`, `deps.bills`, or anything from `controllers/creditCard/*`/`controllers/account/*`/`models/creditCard.ts`/`models/account.ts` — not even a type-only import (enforced: `rg "logic/bill\|deps\.bills" src/controllers/transaction/` and `rg "creditCard|controllers/account" src/controllers/transaction/ src/models/transaction.ts` each match only the header comments that document this rule — no actual import or usage) — this is the shared transaction core (row integrity, category resolution, generic patch/delete primitives, cross-cutting reads) that aggregates depend on, never the reverse. `bulk.ts` (ADR-017 step 2, ADR-022 step 3) makes **no** ownership decision at all — unlike its predecessor `createTransactionsBulk` (which delegated the account-vs-card dispatch to a composition-root router), single-source statement imports fix ownership by construction: whichever aggregate importer (`importCardStatement`/`importAccountStatement`) built the plan already knows which one card/account every line belongs to. `bulk.ts` is pure: `defaultStatementLines` defaults per-line fields (date, idempotencyKey) shared by every import and stamps on the whole import's `rawInput`; `buildBulkResult` shapes the shell's per-line `SequenceOutcome`s back into the `BulkResult` contract. Both are typed purely against the core's own generic `StatementLine`/`ClassifiedUpsertResult`, with no card- or account-shaped field baked into either signature. `bulk.ts` never runs anything itself — each aggregate importer hands the shell a `StatementImportPlan` (defaulted lines + a `flowFor` closure factory), and the MCP/REST handler runs it through `runEffectsSequence` (see `docs/write-path.md`). |
| `controllers/creditCard/*` | Same base `controllers/` rule, **plus** it may depend on `controllers/transaction/{core,read,bulk}.ts` — the credit-card aggregate owns card CRUD (`creditCard.ts`), the bill lifecycle (`bill.ts`), and card-transaction policy (`transaction.ts`: `addCardPurchase`/`updateCardTransaction`/`deleteCardTransaction`/`importCardStatement`), validating (account-type ownership via its own `assertCreditAccountLeg`, built on `controllers/resolve.ts`'s neutral `resolveLegAccounts` — ADR-020; paid-bill immutability; cycle resolution) before delegating row persistence to the core. Never calls `guardTransferMutability` — the one transfer it ever sees (the bill-payment transfer) is blocked outright by its own bill-process guard, not transfer-immutability policy (ADR-020 §3). `importCardStatement` (ADR-017 step 2, ADR-022 step 3) defaults each line via `bulk.ts`, then binds every line to `addCardPurchase` — the same single-line flow `add_card_purchase` calls, unchanged — bound to the ONE card named in the request, and returns the `StatementImportPlan` for the shell to run. |
| `controllers/account/*` | Same base `controllers/` rule, **plus** it may depend on `controllers/transaction/{core,read,bulk}.ts` — the account aggregate owns account CRUD + balances (`account.ts`), account-movement policy (`transaction.ts`: `addAccountExpense`/`addAccountIncome`/`updateAccountTransaction`/`deleteAccountTransaction`/`importAccountStatement` — namespaced as `controllers/account/*` already, so the file doesn't repeat "account" in its own name), and transfers (`transfer.ts`: `createTransfer`, folded in from the former top-level `controllers/transfers.ts` at ADR-016 step 4 — a transfer request is account-context vocabulary even though it persists via the shared core primitive), validating (non-credit account, category/sub-category exclusivity, currency match, distinct legs) before delegating row persistence to the core. `updateAccountTransaction`/`deleteAccountTransaction` assert account-type ownership via their own `assertAccountOwnedLegs` (built on `resolveLegAccounts`, testing membership in `logic/account.ts`'s `isAccountOwnedType` — its own positive scope, not a negation of the credit-card aggregate's test, ADR-020) before delegating to the core's generic patch/delete; `updateAccountTransaction` additionally runs `guardTransferMutability` (`logic/account.ts`, ADR-020 §4) — the only place a regular, mutable transfer is ever reached. `importAccountStatement` (ADR-017 step 2, ADR-022 step 3) defaults each line via `bulk.ts`, then binds every line to `addAccountExpense`/`addAccountIncome` (picked per item by the item's own `type`) — the same single-line flows the individual tools call, unchanged — bound to the ONE account named in the request, and returns the `StatementImportPlan` for the shell to run. |

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

## Write path: functional core / imperative shell (ADR-021 / ADR-022 / ADR-023)

Every write flow is converted: a controller **decides** and returns the write as data
(`ResultAsync<{ persist: Persistable[]; response: T }, AppError>`); the diplomat shell **applies** it. `deps`
exposes no write method — the domain is structurally incapable of writing. These **guardrails** hold for any
change, whether or not it touches this machinery:

- **Controllers return effects, never perform them.** A converted controller builds `Persistable`s (via
  `logic/persistence.ts`'s `insert`/`update`/`remove`) and returns `{ persist, response }` — it never calls a
  repo write method (there are none) and never touches `Db`.
- **Appliers decide nothing and read nothing** (ADR-023). An `EntityApplier` performs the mechanical write and
  only that; every value it persists was chosen by the core. Grep-able proxy: an applier writes exactly one
  table.
- **`version` is a persistence-side optimistic-concurrency token** — on every mutable table, never on a public
  model/wire shape; the shell enforces it and computes the next version in application code, never a SQL-side
  compare-and-set the domain writes.
- **Reads are injected, writes are returned.** `Deps` exposes queries and pure helpers only; the effect runner
  (`RunEffects`) is shell-only, never a field on `Deps`, so a controller can't reach it to apply its own writes.

**Full as-built mechanics — the effect runner (`runEffects`/`runEffectsSequence`), the applier catalogue,
outcome/response shaping, and the per-flow notes — live in `docs/write-path.md`; read it before changing
write-path code.** Rationale and migration history live in ADR-021 (FC/IS), ADR-022 (effect runner), and
ADR-023 (appliers decide nothing).

## Relational schema (as built)

Database: encrypted libSQL file (`fintrack.db`) opened via `@libsql/client` (async) with `drizzle-orm/libsql`. Schema defined in `src/diplomat/db/schema.ts`; migrations generated by `drizzle-kit` and applied at startup via `migrate()`. Key `from @napi-rs/keyring` (ADR-005); `FINTRACK_DB_KEY` env var overrides for CI/headless.

**Concurrency posture (ADR-024).** `openDatabase` (`diplomat/db/driver.ts`) asserts `PRAGMA journal_mode = WAL`
(best-effort — falls back to rollback-journal with a `console.warn` if unsupported by the target build) and
`PRAGMA busy_timeout = 5000` (unconditional; busy_timeout is per-connection) on every open, before returning the
Drizzle handle. WAL lets the HTTP sidecar's reads proceed without blocking the writer; busy_timeout makes a
contended writer wait for the lock instead of throwing `SQLITE_BUSY` immediately — the case that matters when
more than one stdio server (ADR-007, spawned per client) holds a connection to the same file at once.
`runEffects`'s retry loop (`docs/write-path.md` § The effect runner) additionally treats `SQLITE_BUSY` as
retryable the same way it treats a `VersionConflict`, as defense-in-depth for contention that outlives the
timeout. **WAL sidecar files** (`fintrack.db-wal`, `fintrack.db-shm`) appear beside the DB file — back up or copy
the database as a set with them, or checkpoint (`PRAGMA wal_checkpoint`) first.

Every mutable entity table below also carries `version INTEGER NOT NULL DEFAULT 0` (not shown per-line) —
the optimistic-concurrency token `runEffects` uses in its versioned unit-of-work mode (ADR-021 / `docs/write-path.md`;
ADR-022).
`currencies`, `merchants`, `merchant_category`, and `transaction_tags` do not — they are reference/join tables,
not aggregates a flow returns as a `Persistable`.

```
currencies          (code PK, symbol, name, decimals DEFAULT 2 — BRL/USD=2, USDC=6, BTC=8,
                     ADR-026 Phase 1; fiat + crypto, purely additive, no conversion/rates yet)
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
budgets             (id PK, category_id FK→categories — the budgeted node itself, a top-level
                     category or sub-category, limit_amount, currency FK, period: monthly, version —
                     UNIQUE(category_id, currency, period); Feature Design 015 phase 1)
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
                     account_id FK, category_id FK, merchant_key FK, version — Feature Design 017;
                     null on rules created before the migration, no backfill)

settings            (id PK DEFAULT 'singleton', locale: en|es|pt DEFAULT en,
                     locale_source: default|inferred|explicit DEFAULT default, version)
dashboards          (id PK, name UNIQUE, html (nullable), source: inline|file DEFAULT inline, path (nullable),
                     updated_at, version — ADR-013 Phase A, id normalized in Feature Design 013 Phase 1,
                     source/path added ADR-027 Phase 2; CHECK enforces exactly one of html/path per source;
                     see § Dashboards / `/ui` surface)

transactions_fts    VIRTUAL TABLE fts5(description, content='transactions')
                    — kept in sync via INSERT/UPDATE/DELETE triggers
```

Repos live in `src/diplomat/db/repos/`; each accepts a `Db` (`LibSQLDatabase<typeof schema>`) injected from `main.ts`. Drizzle query builder is used for simple CRUD; `db.all(sql\`...\`)` for joins and FTS5 searches. All queries parameterized — never string-interpolate user input.

Seed data (currencies, categories, merchant rules) lives in `src/diplomat/db/seed/` (ADR-008). Seed-only types (`DefaultCategoryId`, `MerchantRule`) live there too — the domain never imports seed.

## Invariants (violations are bugs)

1. **Idempotency**: every Transaction write uses `UNIQUE(idempotency_key)` + `onConflictDoNothing()`; `rowsAffected === 0` means duplicate — return the existing row, `created: false`.
2. **Transfers** are `type: 'transfer'` with both `from_account_id` AND `to_account_id` set (ADR-002); summary/classification queries MUST exclude them (`t.type != 'transfer'`).
3. **Currency**: transactions denormalize the account/card currency at write time; aggregations group per currency, never convert. `CurrencyCode` is BRL/USD/USDC/BTC (ADR-026 Phase 1) — crypto is first-class alongside fiat, purely additive; there is still no conversion or base-currency valuation (that's ADR-026 phases 2–3). Money-amount rounding in `logic/` (`summarize`, `shapeAggregateResult`) is currency-decimals-aware (`roundToDecimals`, `logic/money.ts`) — a currency's own `decimals` (fiat 2, USDC 6, BTC 8) is looked up via `decimalsLookup` from the `currencies` reference list, never hardcoded to 2, so a native BTC/USDC amount isn't flattened to fiat precision.
4. **Balances are derived**, never stored: `initialBalance + income − expenses + transfers in − transfers out`. **Only `effective` transactions count** — pending transactions never affect the current balance. Projection (balance + pending-through-date) is opt-in via `projectedAsOf` on `get_account_balances`.
   - **Effective-only invariant (Feature Design 001)**: `get_account_balances` and `get_spending_summary` MUST filter `status = 'effective'`. Projection queries explicitly include `pending`. Classification ignores status. This is enforced in `diplomat/db/repos/` — violations are bugs.
5. **Classification via merchant_category**: normalized description → `merchants.key` → strongest `merchant_category` edge; user corrections increment `weight` (`onConflictDoUpdate`). **Recurring rules carry a merchant too (Feature Design 017)**: `create_recurring` resolves `recurring_rules.merchant_key` from an explicit `merchant` (stored as given, normalized) or, failing that, the same `merchant_category` match-first precedence `planAccountMovement` uses for transactions — reusing an already-learned key over a fresh full-description normalize — so a rule reinforces the same merchant identity a matching transaction would; every occurrence `apply_due_recurring` materializes inherits the rule's `merchant_key`, so recurring spend participates in merchant concentration and classification like any other transaction. Rules created before the migration have `merchant_key = null` (no backfill — `normalizeMerchant` can't be faithfully reproduced in SQL) until re-saved. This `merchant_key` is what `find_correlations`'s `recurring_candidates` mode (Feature Design 016 phase B) excludes on exactly: a candidate merchant already backing a rule is filtered out in SQL via `t.merchant_key NOT IN (SELECT merchant_key FROM recurring_rules WHERE merchant_key IS NOT NULL)` — a pre-017 rule (`merchant_key = null`) doesn't match and so can still surface as a candidate until re-saved.
6. **Category kind must match transaction type**: `expense` transactions may only use `expense` or `both` categories;
   `income` may only use `income` or `both`. Enforced in `controllers/transaction/core.ts`'s `resolveCategory`/
   `resolveSubCategory` (shared by every movement path) via `isCategoryKindAllowed` (predicate in `logic/transaction.ts`).
7. **Sub-category always paired with parent**: `subcategory_id` set → `category_id` must also be set to the sub-category's parent. Enforced by a `CHECK` constraint and in `controllers/resolve.ts`.
8. **Card purchases are funded by the card's internal liability account (debt).** Bill payment is a canonical transfer (ADR-002) from a bank account to the card account, excluded from spending summaries — never an expense (double-count). `pay_bill` creates it, links it via `bills.payment_transaction_id`, and marks the bill paid. Value enters a `credit` account only via `pay_bill`. **A `paid` bill has at most one payment transfer** (Feature Design 011): created only by `pay_bill`, removed only by `revert_bill_payment` (which deletes the transfer and flips `paid → closed` — the exact inverse; both are idempotent no-ops outside that transition). A bill marked paid with a non-positive total has no transfer (`payment_transaction_id` absent) — revert still flips it to `closed`. **A `paid` bill is composition-immutable** (Feature Design 012): `add_card_purchase` rejects landing a transaction on a `paid` bill (whether by explicit `billMonth`/`billYear` or plain cycle auto-assignment), `update_card_transaction` rejects moving a transaction off a bill that is currently `paid` (and rejects editing the bill-payment transfer itself outright — ADR-017), and `delete_card_transaction` rejects any transaction whose `bill_id` points at a `paid` bill — not just the payment transfer (which is itself always covered, since its own `bill_id` is the bill it paid, even though the transfer itself has no `credit_card_id`; ADR-017's union ownership rule — `cardId` **or** `billId` — routes the payment transfer to `update_card_transaction`/`delete_card_transaction` by construction, not by a composition-root lookup). Every case points the caller at `revert_bill_payment`; none of these guards ever auto-revert. `transactions.bill_id` is assigned automatically by cycle (`billPeriodFor`) or, when given, by an explicit `billMonth`/`billYear` (`billPeriodForCycle`) — either way it is set on the transaction row **at insert/update time itself** (`controllers/creditCard/transaction.ts`'s `resolveBillWrite` decides insert-a-fresh-`open`-bill vs. version-guarded-touch-the-existing-one as a `Persistable`, applied atomically with the transaction write by the shell; there is no separate "attach" step and so no orphan row to self-heal) — and is readable on `TransactionView` as `billId`. A transaction can only ever belong to a bill of its own card (structural: there is no way to change a transaction's card via `update_card_transaction`). All of this policy lives in the credit-card aggregate (`controllers/creditCard/transaction.ts`), never in the transaction core (ADR-016). **A card's internal account name always tracks the card's own name** (Feature Design 014 phase C): `Card: {name}` (ADR-010), kept in sync by `update_credit_card`'s rename — a two-entity update batch renaming the card and its internal account together, atomically. Nothing else ever renames that account independently.
9. **Encryption on by default**: the database is always opened with an encryption key (from keychain or `FINTRACK_DB_KEY`). Opening without a key is a startup error. The key is never logged or committed (ADR-005).
10. Decode at the boundary: every external input and SQL row is zod-parsed before entering the domain.
11. **Dynamic query structure is composed only from whitelisted enum-keyed SQL fragments** (ADR-011); caller-supplied values are always parameter-bound; caller text is never concatenated into SQL. Exhaustive `Record<Enum, Fragment>` maps in `diplomat/db` are the only source of structural SQL; `assertNever` / TS exhaustiveness guards unmapped keys at compile time.
12. Behavior changes require tests: domain and boundary behavior updates must include unit tests in the same change (success and expected-failure paths).
13. **Category identity is the slug/id, not the localized name** (Feature Design 002, ADR-009). Default categories carry a JSON `names` column (`{"pt":"…","es":"…"}`); display name is resolved at read time as `names?.[locale] ?? name`. Merchant rules and classification key on the slug, never the display name. User-created categories have `names = null` and keep their literal `name`.
14. **Locale is AI-determined, stored, env-overridable** (Feature Design 002). `settings.locale` (`en|es|pt`), default `en`. Resolution: `FINTRACK_LOCALE` env → `settings.locale` → `'en'`. `set_locale` with `source: inferred` is rejected when `locale_source` is `explicit`.
15. **Seed is isolated (ADR-008).** Seed data lives in `diplomat/db/seed/`; the domain (`models/`, `logic/`, `controllers/`) never imports it. The app boots and works on an empty (unseeded) DB.
16. **Unbounded collections page by keyset cursor with the paginated envelope (ADR-014).** `search_transactions` (first mover) returns `{ items, nextCursor?, total? }`; `ORDER BY` is composed only from a whitelisted enum-keyed column map (`ORDER_BY_COLUMN` in `wire/db/transactions.ts`, turned into SQL only in `diplomat/db/repos/transactions.ts`), the same mechanism as invariant 11 applied to ordering — caller text never reaches `ORDER BY`. Cursors are opaque, zod-validated at the boundary, and bound to the `sort`/`dir` that produced them (a mismatch is a `validation` error). `total` is opt-in (`includeTotal`) — an extra same-WHERE `COUNT(*)`, never paid by sequential "walk until no `nextCursor`" consumers. Small, cycle-bounded `list_*` endpoints stay plain arrays; the envelope is the signal a collection can page.
17. **No god write flows for any transaction mutation (ADR-017, complete; ownership mechanism revised by ADR-020).** The only cross-cutting transaction surface is the read side (`search_transactions`, `get_spending_summary`, `aggregate_spending`, account balances); every write is an aggregate-specific entry point that validates ownership itself and never dispatches by inspection — there is no composition-root router. Update/delete: `update_card_transaction`/`delete_card_transaction`, `update_account_transaction`/`delete_account_transaction`. **Ownership is resolved by account type, not by a core structural discriminator (ADR-020), and each aggregate asks its own question rather than sharing one judgment:** `controllers/resolve.ts`'s `resolveLegAccounts` is a neutral I/O helper (resolves the accounts referenced by a transaction's leg(s) — `accountId`/`toAccountId` — via `deps.accounts.findById`; makes no ownership judgment of its own). The credit-card aggregate's own `assertCreditAccountLeg` (`controllers/creditCard/transaction.ts`) asks "is a leg `credit`" (ADR-010) — true for a card purchase (`accountId` **is** the card's own internal account) and the bill-payment transfer (`toAccountId` **is** that same account). The account aggregate's own `assertAccountOwnedLegs` (`controllers/account/transaction.ts`) asks the different, positive question "is every leg one of *my* types" against `logic/account.ts`'s `isAccountOwnedType` (an enumeration of `checking`/`savings`/`wallet`/`investment` — the account domain's own scope, not the negation of `credit`; vacuously true for an unattached movement with no legs at all). Neither aggregate reuses or negates the other's predicate, and the core owns no ownership discriminator at all. A wrong-tool call is rejected with a `validation` error naming the correct tool (`transactionErrors.wrongTool`, raised by each aggregate's own guard) — a guard, not a redirect the server performs on the caller's behalf. Card purchases and the bill-payment transfer are card-owned; regular movements and transfers are account-owned. Transfer *mutation* policy (`guardTransferMutability`, the `transferTypeImmutable`/`transferCategoryRejected` errors) lives wholly in the account context (`logic/account.ts`, `models/account.ts`) — the credit-card aggregate never reasons about transfer invariants; its one transfer (the bill-payment transfer) is blocked outright by its own bill-process guard — a `validation` error naming `revert_bill_payment` — not by transfer-immutability. Bulk: `import_card_statement`/`import_account_statement` are single-source — a statement belongs wholly to the ONE card/account the caller named, so there is no per-line owner to decide; the shared `controllers/transaction/bulk.ts` helpers (`defaultStatementLines`/`buildBulkResult`) only default per-line fields and shape the result, making no ownership decision.
18. **The transaction core's movement schema is minimal (ADR-019 step 1).** `CreateTransactionSchema`/`UpdateTransactionSchema` (`models/transaction.ts`) carry only genuinely-shared ledger vocabulary (description, amount, type, status, date, category/subCategory, currency, idempotencyKey, rawInput, note, tags) — they name no sibling context's field. Each aggregate `.extend`s the core up with its own vocabulary rather than the core carrying the union for aggregates to `.omit` down: `AddCardPurchaseSchema` (`models/creditCard.ts`) adds `card`/`billMonth`/`billYear`; `UpdateCardTransactionSchema` adds `billMonth`/`billYear` (bill reassignment — no `card` field, since a transaction's card can't change on update); `AddAccountMovementSchema`/`UpdateAccountTransactionSchema` (`models/account.ts`) add `account`. The field-tied bill errors (`billPeriodIncomplete`, `billAssignmentRequiresCard`) moved with the fields to `cardErrors`. One documented exception: `UpdateCardTransactionSchema` also `.extend`s `account` (rather than leaving it out) purely so `controllers/creditCard/transaction.ts`'s `updateCardTransaction` can keep rejecting it with its dedicated `cardErrors.accountChangeRejectedForCard` message — omitting the field would replace that message with a generic `.strict()` unrecognized-key error, a worse-not-better outcome. Transfer is the boundary case: the transfer *row kind* (`TransactionType.enum.transfer`, balance/summary math, `TransactionView.toAccountId`) stays core because the shared read/balance side is structurally defined over it (`resolveEffectiveType` stays in `logic/transaction.ts`); transfer *policy* (`guardTransferMutability`, the `transferTypeImmutable`/`transferCategoryRejected` errors) lives in the account context (ADR-020). Currency resolution lives in `logic/money.ts` (context-neutral: a `{ currency } | null` funding source plus the input override); `assertBillPeriodPaired`/`withBillId` live in `logic/bill.ts` (credit-card context).
19. **Every write flow returns its writes as data; none perform them (ADR-021/022/023, complete repo-wide).**
    A converted controller builds `Persistable`s and returns them in `persist` (or, for bulk import, a
    `StatementImportPlan` the shell runs through `runEffectsSequence`); it never calls a repo write method and
    never touches `Db`. **`deps` exposes no write method at all, for any entity** — every repo is read-only
    (queries and pure helpers only), and no domain rule survives as a SQL predicate in a repo. Only
    `diplomat/db/effects.ts` (invoked from the MCP/REST handler) touches `Db`. The per-flow conversion history,
    the applier catalogue, the `versionedTableApplier` unique-conflict/singleton-race handling
    (`dashboardApplier`/`settingsApplier`), and the `resetLocale`-to-shell move live in `docs/write-path.md`
    and ADR-021/022/023 — not here.
20. **An `effective` transaction's date is never in the future** (Feature Design 014). Enforced at `pay_bill`
    (phase A: the payment transfer's date must be on or before today) and `confirm_transaction` (phase B: the
    resolved date — the given `date`, or the existing date if omitted — must be on or before today,
    `transactionErrors.cannotConfirmFutureDated`). The date-aware create default already respects this
    structurally (a future-dated create with no explicit `status` defaults to `pending`, never `effective`) — a
    caller who explicitly passes `status: effective` with a future `date` on a create/import tool is not guarded
    by this invariant (a known gap, deliberately out of this design's scope). Confirm additionally rejects editing
    `amount`/`date` on a transfer or bill-payment transaction (`isTransfer`, `logic/transaction.ts` — core-visible
    via `type === 'transfer'`, ADR-002); a plain status-only confirm of one is still allowed, since it makes no
    date claim of its own.
21. **Budgets are keyed by (target, currency, period) — no cross-currency total, no rollover**
    (Feature Design 015, the first entity built entirely on the FC/IS write path from scratch
    rather than migrated). A budget's `category_id` is the budgeted node's own id — a top-level
    category or sub-category, both rows in `categories` — so `UNIQUE(category_id, currency,
    period)` needs no nullable discriminator; measurement can still tell top from sub via the
    target's own `parent_id`. Only an expense-eligible category may be budgeted (`kind` is
    `expense` or `both`; a pure `income`-kind target is rejected, `budgetErrors.notExpenseCategory`)
    — a budget caps spending. Each period is measured independently; there is no unused-budget
    carryover. `create_budget`/`update_budget`/`delete_budget`/`list_budgets` (phase 1) manage the
    limits themselves. **The measurement invariant (phase 2, `get_budget_status(month, year)`,
    revised by Feature Design 020 from effective-only to effective+committed, and by ADR-028 from a
    fused repo join to controller-orchestrated correlation):** `transactionsRepo.spendByCategory`
    owns one aggregation over **its own** dimensions — `type = 'expense'`, dated in the month, split
    by `currency`/`category_id`/`subcategory_id`, with two conditional sums per row: **`effective`**
    (`status = 'effective'`, cleared spend) and **`pending`** (`status = 'pending'`) — one query, one
    WHERE, so the two stay consistent by construction. It knows nothing of budgets. `getBudgetStatus`
    (`controllers/budgets.ts`) fetches this alongside `budgetsRepo.list()` and hands both to
    `logic/budget.ts`, which does the actual correlation — the `budgetTargetMatch` rule, now pure
    code: a budget targeting top-level node `T` sums every spend row whose `category_id = T` (this is
    what rolls up sub-category spend for free, since a sub-category transaction's `category_id` is
    always its parent's); a budget targeting sub-category `T` sums only rows whose
    `subcategory_id = T`. `committed` (effective + pending, the earmark-aware measure) and `pending`
    (committed − effective, surfaced for convenience) are then derived per budget, each measure
    carrying its own `amount` and `pct` (`amount / limit`). **`type = 'expense'`, not merely
    `!= 'transfer'`, is budgets' own addition** — a `both`-kind category is a legitimate target (only
    pure `income` is rejected, above), and unlike `aggregate_spending`/`get_spending_summary` (which
    keep `type` as an explicit output dimension their callers/shaping code separates), each measure
    here is one collapsed scalar with no such dimension, so an income transaction booked to a
    `both`-kind category must be excluded at the filter itself or it would inflate a spending cap. A
    sub-category transaction counts toward both its own budget and its parent's, when both exist.
    `remaining` (limit − committed.amount, the earmark-aware headroom) and each measure's `pct` can
    go negative / exceed 1 — over-budget is reported, never an error; effective headroom is
    trivially `limit − effective.amount` for a caller that wants it. The response groups every
    budget by its top-level category name (per-currency and per-sub-category lines read as one
    coherent unit; still no cross-currency total — that needs FX, the deferred PLAN open question).
    **The read surface (`list_budgets`,
    `get_budget_status`) honors invariant 13's locale resolution**: the repo
    (`diplomat/db/repos/budgets.ts`) selects the budgeted node's (and, for a sub-category target,
    its parent's) raw name plus `names` JSON only — no locale/display decision — and
    `logic/budget.ts` resolves the display name from raw name + `names` + `deps.locale()`, over
    the same `budgetsRepo.list()` read `find_correlations`'s `budget_fit` analysis now reads too
    (ADR-028 phase 3, below). `create_budget`/`update_budget` resolve the same way for a
    top-level-category target; a sub-category target still reports its parent's raw, unlocalized
    name (tracked in issue #169 — `SubCategory` carries no `parentNames`).

22. **`find_correlations`'s `budget_fit` analysis is controller-orchestrated, same as
    `get_budget_status` (ADR-028 phase 3, completes the migration).** `correlationsRepo` no longer
    joins `budgets`; the `budgetTargetMatch`/`BUDGET_FIT_SELECT` fused-join query is retired
    entirely. `transactionsRepo.spendByCategoryWindowed` extends the `spendByCategory` pattern
    (invariant 21) with a **baseline/current** window split instead of an **effective/pending**
    status split — same own dimensions (currency, `category_id`, `subcategory_id`), same
    `txPredicates`-composed WHERE (`expense` + `effective` only — `budget_fit` measures cleared
    spend, not pending). The `findCorrelations` controller (`controllers/correlations.ts`) fetches
    `budgetsRepo.list()` and this windowed spend in parallel and hands both to
    `logic/correlations.ts`'s `shapeBudgetFitLines`, which reuses `logic/budget.ts`'s
    `isSubCategoryRow`/`resolveTargetNames`/`matchesTarget` (exported for this one reason) rather
    than re-deriving the same top-level-rollup/sub-category-match rule a second time — one matching
    rule, two consumers. The `budgeted`/`unbudgeted` response contract is unchanged; `unbudgeted`
    still reuses `correlationsRepo.spendingShifts` (a category-only, budget-unaware read — out of
    ADR-028's scope).

## Tool surface

51 MCP tools (contract: `docs/mcp-tools.md`), most mirrored as REST routes, both thin over the same controllers — `list_budgets`/`get_budget_status` (Feature Design 015) now have REST parity (`GET /api/budgets`, `GET /api/budgets/status`); `create_budget`/`update_budget`/`delete_budget` and `find_correlations` (Feature Design 016) are MCP-only for now, no REST mirror yet. Client connections: `docs/mcp-clients.md`.

**Transport:** controlled by `MCP_TRANSPORT` (zod enum, `config.ts`). Default is **`stdio`** — the client spawns the process; no port, no Fastify. Set `MCP_TRANSPORT=http` to start the Fastify server (REST + streamable HTTP MCP on `PORT`). Both transports connect the same `buildMcpServer(deps, version)` core; no domain code moves. (ADR-007)

## Diplomat edge organization (ADR-025)

Both diplomat edges are organized as per-domain registration/route modules mirroring `controllers/`, rather than
one large file each. **The convention:** a new MCP tool/resource/prompt or HTTP route lives in the domain module
matching its controller; the entrypoint (`server.ts`/`routes.ts`) never inlines a new registration.

**MCP — `diplomat/mcp`.** `tools/<domain>.ts` (`account`, `creditCard`, `transaction`, `transfer`, `budget`,
`recurring`, `category`, `tag`, `dashboard`, `correlations`, `aggregate`, `summary`, `system`) each export a
`register<Domain>Tools(server, ctx)` that registers exactly the tools whose controller lives in that domain —
`aggregate`/`summary` get their own thin module for the same reason `correlations` does: a single-tool domain is
still a domain, mirroring its single-file controller (`controllers/aggregate.ts`/`summary.ts`). `resources.ts`
(`registerResources`) and `prompts.ts` (`registerPrompts`) stay single cross-domain modules — few enough, and
cross-cutting enough, not to warrant per-domain splitting. `respond.ts` holds the shared response helpers
(`json`, `jsonError`, `fromResult`, `jsonResource`); `context.ts` defines `McpContext` (`{ deps, version,
runEffects, runEffectsSequence, resetLocale }`), built once in `server.ts` and passed to every register call so
no module carries the full parameter list. `server.ts` reduces to construction + aggregation: build the server,
build `ctx`, call each `register…` once.

**HTTP — `diplomat/http`.** `routes/<domain>.ts` (`account`, `category`, `creditCard` — including `Bills`
alongside credit cards, same as the MCP side — `transfer`, `recurring`, `transaction`, `tag`, `currency`,
`dashboard`, `aggregate`, `summary`, `system`) each export a `<domain>Routes(ctx): RouteDefinition[]` — exactly the routes
whose controller lives in that domain. Each module declares its own `<DOMAIN>_TAG` constant(s) for its OpenAPI
tag(s) (`creditCard.ts` alone has two: `CreditCards` and `Bills`) rather than pulling from a shared enumeration,
since no tag is used by more than one domain file. `respond.ts` holds the shared response helpers (`send`,
`parse`) and OpenAPI response/param shorthands (`validation422`, `notFound404`, `conflict409`, `nameParam`,
`idParam`, `confirmQuery`, `CACHE_CONTROL_NO_CACHE`); `context.ts` defines `HttpContext` (`{ deps, version,
runEffects, runEffectsSequence }`), built once in `routes.ts` and passed to every route builder. `GET /ui`,
`GET /ui/:name`, and `GET /ui/assets/{app.css,app.js,money.js}` — browser-facing HTML/asset routes, not
`RouteDefinition`s (no OpenAPI entry) — are mounted by `routes/ui.ts`'s `registerUiRoutes(app)`, called from
`registerRoutes` alongside `mountRoutes` (ADR-027 Phase 1; see § Dashboards / `/ui` surface). `routes.ts`
reduces to construction + aggregation: `buildRouteDefinitions` concatenates every domain's array into the one
list `mountRoutes`/`buildOpenApiDocument` consume (§ OpenAPI contract), and `registerRoutes` mounts it, the UI
shell/asset routes, and `/api/openapi.json`.

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

Every REST route is declared exactly once, in its domain module under `diplomat/http/routes/` (§ Diplomat edge organization), and concatenated by `diplomat/http/routes.ts`'s `buildRouteDefinitions(deps, version)` into a single array where each entry carries its method, path, `wire/in`/`wire/out`/`models`-derived request/response schemas, **and** its real handler together. There is no second, hand-maintained list to fall out of sync: `mountRoutes` (`diplomat/http/openapi.ts`) mounts the array on Fastify, and `buildOpenApiDocument` documents the same array via `@asteasolutions/zod-to-openapi`'s `OpenApiGeneratorV3` — neither function depends on the other, so a route that's mounted is, by construction, the same route that's documented. (An earlier version of this kept the route list and the OpenAPI registry as two separate, manually-synced files; that duplication was the actual defect, not something a parity test should merely detect after the fact — so the design was collapsed to one array instead. A unit test (`test/unit/diplomat/http/openapi.test.ts`) still checks the two consumers agree, mainly to guard against a future route being mounted by hand outside the array.)

The same document is exposed as the MCP resource `fintrack://openapi` (`diplomat/mcp/resources.ts`), so a tools/resource-only agent — including under the **stdio** transport, which never starts Fastify — can read the contract without an HTTP round-trip. This is the first MCP resource in the app (as opposed to tools). It calls `buildOpenApiDocument(buildRouteDefinitions(deps, version), version)` directly: building the array only constructs handler closures (never invokes them), so it needs no live Fastify instance. `diplomat/mcp` importing `buildRouteDefinitions`/`buildOpenApiDocument` from `diplomat/http` is a narrow, documented exception to the dependency table (§ Dependency direction) — both are deterministic, no-business-logic builders, the same category of shared artifact both diplomats already import (wire schemas, models).

`diplomat/http/openapi.ts` holds only routing/doc-generation mechanics (`RouteDefinition`, `mountRoutes`, `buildOpenApiDocument`) — no wire schemas. Response shapes with no dedicated `wire/out` schema before this change (e.g. `BillView`, `ApplyDueResult`, the credit-card delete dry-run union, the shared `{ error }` envelopes for 404/409/422) got new small `wire/out` schemas (`wire/out/{bills,recurring,creditCards,common,errors}.ts`), same as any other response shape; request-side generic path-param/query shapes (`name`, `id`, `confirm`) got `wire/in/common.ts`. Unlike request schemas, these response schemas are not zod-validated at runtime (routes never parse their own outbound payloads), so they are best-effort documentation, not an enforced contract.

## Reference resources (Feature Design 018)

`fintrack://categories`/`accounts`/`tags`/`credit-cards` (`diplomat/mcp/resources.ts`) are read-only, static-URI MCP resources that reuse the matching `list_*` read controller verbatim and serialize its result — the resource and its tool can never disagree, same principle as `fintrack://openapi` reusing `buildOpenApiDocument`. `fintrack://merchants/top` is the one addition with a new read path: `MerchantsRepo.top(limit)` (`diplomat/db/repos/merchants.ts`) groups effective, non-transfer transactions by `merchant_key`, resolves each merchant's dominant category (by transaction frequency, ties broken alphabetically), orders by count descending, and caps at `DEFAULT_TOP_MERCHANTS_LIMIT` (`models/merchant.ts`, 20) — a `controllers/merchants.ts#topMerchants` locale-resolves the category name before the resource serializes it. No `ResourceTemplate`/caller-supplied limit — it's a vocabulary list, not a tunable report. `fintrack://currencies` (ADR-026 Phase 1) mirrors `GET /api/currencies` — both call `controllers/currencies.ts#listCurrencies` (`CurrenciesRepo.list()`, `diplomat/db/repos/currencies.ts`) — rather than a `list_*` tool, since there is no MCP write-side counterpart for currencies (a seeded reference table, never user-mutated): `{code, symbol, name, decimals}` per currency, the metadata a client needs to format a non-ISO code (USDC/BTC) that `Intl.NumberFormat`'s currency mode rejects.

## Guided-workflow prompts (Feature Design 019)

The MCP surface also includes `server.registerPrompt` templates (`monthly_review`, `budget_checkup`, `import_statement` — text and registration in `diplomat/mcp/prompts.ts`'s `registerPrompts`, called from `buildMcpServer`): orchestration prose, not a new data path. Each returns a `{ messages }` result instructing the model which existing tools to call and how to narrate the outcome; no DB access, no controller.

## Dashboards / `/ui` surface (ADR-013, ADR-027)

The browser dashboard surface — the app shell, dashboard **content fragments**, the `source: inline|file`
discriminator (default dashboards are git-versioned `.html` files under `ui/dashboards/`; customs are DB-
`inline`, and `save_dashboard` is **always** `inline` so path-traversal is structurally impossible), bootstrap
reconciliation, the management flows (`save`/`delete`/`rename`, all FC/IS), and entity-tagged **SSE** live-update
fed by the `runEffects` post-commit hook — is documented in full in **`docs/ui.md`**. The `dashboards` table
shape is in § Relational schema; decisions + rationale are in ADR-013 and ADR-027.

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
- ADR-017: no god write flows — bounded-context ownership for every transaction mutation (extends ADR-016; ownership discriminator revised by ADR-020)
- ADR-018: atomic bill payment via a transactional repo write — **superseded by ADR-021** before implementation
- ADR-019: minimal transaction core — aggregates `.extend` the shared movement schema up, never `.omit` it down
- ADR-020: transaction ownership by account type, not structural field-presence (revises ADR-017's union rule)
- ADR-021: functional core / imperative shell for the write path — controllers return the write as data; a generic versioned unit of work applies it (supersedes ADR-018)
- ADR-022: the shell's executor is a generic effect runner (`runEffects`/`runEffectsSequence`) — single atomic unit or sequence of independent units (renames/extends ADR-021)
- ADR-023: an applier decides nothing and performs no reads — merchant/tag/learning decisions move into the core; idempotency is the engine's, declared by registration config (extends ADR-021/022)
- ADR-024: local SQLite concurrency posture — WAL + `busy_timeout` + `SQLITE_BUSY` retryable in `runEffects`; multi-client use steered to the HTTP transport (ADR-007)
- ADR-025: diplomat edge organization — MCP tools/resources/prompts and HTTP routes in per-domain modules mirroring `controllers/`; entrypoints only aggregate
- ADR-026: multi-currency valuation — crypto (USDC, BTC) first-class, agent-refreshed `currency_rates` table, `settings.base_currency`, read-time conversion on `get_account_balances`; relaxes no-implicit-conversion for **valuation** only (**accepted**; Phase 1 — crypto currencies — complete, phases 2–3 — rates/base-currency, account valuation — pending)
- ADR-027: UI app shell — shared shell hosting dashboard **content fragments**; `source: inline|file` discriminator (defaults are git-versioned files, customs stay inline, `save_dashboard` always inline); entity-tagged **SSE** live-update; same Fastify, no build (extends/revises ADR-013; see `docs/ui.md`)
- ADR-028: read-side cross-aggregate correlation lives in controllers, not repos — refines ADR-011 (aggregation stays in the repo; correlating two aggregates does not); transaction "what counts" predicates single-sourced (`txPredicates`); applied to `get_budget_status` (phase 2) and `find_correlations`' `budget_fit` (phase 3, complete) — `budgetTargetMatch` fully retired
