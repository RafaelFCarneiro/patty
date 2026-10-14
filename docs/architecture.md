# FinTrack v2 — Architecture (as built)

> **This file describes the system as it IS.** Update it in the same change that alters architecture.
> Roadmap and vision: `docs/PLAN.md`. Decisions + rationale: `docs/adr/`. Agent instructions: `CLAUDE.md`.
> Layer concepts: `docs/diplomatic-architecture.md` (where the layers are) and
> `docs/functional-core-imperative-shell.md` (what crosses the write-path boundary between them — ADR-021,
> mandatory reading alongside the Diplomat doc for any write-flow change).
> Write-path mechanics: `docs/write-path.md`. Browser `/ui` surface: `docs/ui.md`. Operator guide to authentication: `docs/auth.md`.

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
            @rfc0/effect-runner (external package: effect engine + data contract; diplomat/db is its SQLite adapter)
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
| `controllers/` | `logic/`, `models/`, `common/`, `@rfc0/effect-runner` (the `Persistable`/`FlowOutcome` data contract), injected deps interfaces |
| `logic/` | `logic/`, `models/`, `common/net.ts` (pure host/origin string helpers — `isLoopbackHost`, `hostnameOfHostHeader`; no I/O — used by `logic/auth/origin.ts`'s `isLoopbackRequest`), `@rfc0/effect-runner` (the `Persistable`/`PersistOutcome`/`FlowOutcome` data contract — `logic/persistence.ts`'s builders) only |
| `models/` | zod/schema helpers, `models/error.ts` (shared error primitives), `@rfc0/effect-runner` (`withPersistenceMeta` — the version-token nucleus). Each model defines its own error union and payload builders (ADR-012); models never import the composed `AppError`. |
| `@rfc0/effect-runner` (external, MIT, npmjs.com — own repo) | The effect engine and its data contract; its public API is semver-governed and FinTrack imports only that. No database driver, ever; it knows nothing of FinTrack. Behavior is documented in the package. |
| `models/creditCard.ts` | Same base `models/` rule, **plus** it may depend on `models/transaction.ts` (ADR-016: the aggregate model may depend on the core model, never the reverse) — `AddCardPurchaseSchema`/`UpdateCardTransactionSchema` `.extend` the core's minimal `CreateTransactionSchema`/`UpdateTransactionSchema` (ADR-019 step 1) with credit-card-only vocabulary the core no longer carries at all: `AddCardPurchaseSchema` adds `card` (required) plus `billMonth`/`billYear`; `UpdateCardTransactionSchema` adds `billMonth`/`billYear` (bill reassignment — there is no `card` field on update, a transaction's card can't change) plus `account`, kept reachable only so `cardErrors.accountChangeRejectedForCard` can fire (see invariant #18). Same for the errors: `cardErrors.paidBillImmutable`/`cardErrors.accountChangeRejectedForCard` are raised exclusively by the credit-card aggregate (`controllers/creditCard/transaction.ts`), never the core, so their payloads live here — and, since ADR-019 step 1, so do `cardErrors.billPeriodIncomplete`/`cardErrors.billAssignmentRequiresCard` (moved from `models/transaction.ts`'s `transactionErrors`, where the core used to raise them itself before the minimal-core change removed the fields that made that necessary). This mirrors the controller-layer arrow at the schema/error-vocabulary layer: hosting an aggregate-exclusive schema or error inside the "core" model file would be the same bounded-context leak the ADR exists to prevent, even without a literal import cycle — the test is not "is this ValidationError-shaped" (both sides are) but "who is the only caller." |
| `models/account.ts` | Same base `models/` rule, **plus** it may depend on `models/transaction.ts` (ADR-016 step 3: same aggregate-may-depend-on-core rule as `models/creditCard.ts` above) — `AddAccountMovementSchema`/`UpdateAccountTransactionSchema` `.extend` the core's minimal `CreateTransactionSchema`/`UpdateTransactionSchema` (ADR-019 step 1) with `account`, the one field this aggregate owns (card/bill vocabulary never reaches the core at all, so there's nothing left here to omit). `accountErrors.creditPostRejected` (raised only by the account aggregate, `controllers/account/transaction.ts`) already lived here before this split, consistent with the same rule. `CreateTransferSchema` moved here at ADR-016 step 4 (from `models/transaction.ts`, which never had a `createTransfer` entry point of its own) for the same reason: a transfer request is account-context vocabulary, even though `transfer.ts` persists it via the core's `TransactionType.enum.transfer` row shape. |
| `common/errors` | `models/` (composes `AppError` as the union of per-model error types; ADR-012) |
| `adapters/` | `models/`, `wire/*`, `@rfc0/effect-runner` (`INITIAL_VERSION`/`PersistOp` — e.g. `adapters/bills.ts`'s hand-written `persistableToDb`) |
| `diplomat/*` | `controllers/`, `adapters/`, `models/`, wire schemas, runtime clients |
| `diplomat/http`, `composition/http.ts` → `@rfc0/effect-runner` | **Type-only**: the `ChangeBus` type (`['subscribe']`) for the SSE route's parameter; the bound bus is built in the composition root (`composition/runtime.ts`) and passed in, never constructed inside `diplomat/*`. |
| `diplomat/db` | Same base `diplomat/*` rule, **plus** `@rfc0/effect-runner` — it is the SQLite adapter implementing the port the package's engine defines (`versionedTableApplier` builds an `EntityApplier`; `driver.ts`'s `createTransactionRunner` implements `TransactionRunner`; `sqliteErrors.ts`'s `isSqliteBusy` implements `IsTransientContention`). Imports the package, never the reverse. |
| `diplomat/auth/credentials.ts` | `controllers/deps.ts` (type-only: the `AuthSecrets` shape it implements), `models/auth/token.ts` (`TOKEN_PREFIX`), `@node-rs/argon2`, `node:crypto` — the real hashing/randomness behind the injected `AuthSecrets`. Loaded lazily (`composition/auth.ts`) so a run with auth disabled never loads the native argon2 module. |
| `diplomat/auth/signInStore.ts` | `controllers/deps.ts` (type-only: the `SignInStore` port it implements), `models/auth/signIn.ts` (`KEYCHAIN_SERVICE`), `@napi-rs/keyring` (loaded lazily, like `diplomat/db/driver.ts` loads it for the database key), wrapped exactly once (`useEntry`): `load` answers `ResultAsync<string | null, KeychainFailure>` (`models/auth/signIn.ts`) — an unreadable keychain is an error, not "nothing saved" — while `save` answers whether it kept the secret and `clear` never fails. The only place a saved stdio sign-in touches the OS keychain. |
| `diplomat/mcp/stdioSession.ts`, `gate.ts`, `scopes.ts` | The base `diplomat/*` rule — `controllers/deps.ts` (type-only: the `SignInInterpreter` port `stdioSession.ts` is handed), `logic/auth/signInFlow.ts`'s `pendingOf` and `logic/auth/message.ts`'s `notSignedInMessage` (the pure decisions an edge may read), `models/auth/signInFlow.ts` (states, observations, presentations), `wire/in/auth.ts` (`clientInfoOf`). `stdioSession.ts` is the stdio channel's identity edge and a thin presenter: it feeds one observation at a time to the interpreter, runs the poll timer exactly while a request is open, and turns what the protocol said into a `GateOutcome`; it decides nothing, runs no effect, and imports no other `diplomat/*`. |
| `diplomat/db/versionGuard.ts` | `diplomat/db/migrationJournal.ts` (`lastAppliedMillis`, `readJournal` — the one module that knows both what a build ships and what a database applied; `safetyCopy.ts` uses it too), `logic/migration.ts` (`isDatabaseAhead`), `models/database.ts` (the message). Read-only; `bootstrap` calls it before anything is copied, migrated or seeded. |
| `diplomat/cli/` (inbound edge) | The base `diplomat/*` rule, **plus** `models/auth/password.ts`' `UsernameSchema`/`PasswordSchema` (the answers a person types are decoded with the very schemas `/ui/setup` uses), `wire/in/cli.ts` (the CLI's argv grammar: the commands and subcommands, their flag schemas and how many positionals each takes; the exit codes are `io.ts`'s, the edge's outcome translation) and `models/database.ts` (`databaseAheadMessage`, which a refused `openShell` is printed with). `commands.ts` is the argv router (a thin aggregator, like `diplomat/http/routes.ts`); `commands/{auth,login,setup}.ts` are the handlers — parse flags, prompt, call a controller or the injected `Shell.signIn` interpreter, print, return an exit code; `io.ts` declares the `CliIo`/`Shell` ports the handlers are written against (and the exit codes) and `messages.ts` the operator wording. `terminal.ts` is the only place that touches `node:readline` and stdin/stdout for prompting (a prompt answers a `ResultAsync<string, PromptEnded>`: Ctrl-C is `interrupted` — the handlers end with `EXIT_INTERRUPTED` — and Ctrl-D is `cancelled`, a failure with the one-line "cancelled" message, or "not now" at the sign-in offer; nothing under `diplomat/` ends the process — `process.exit` is for `main.ts` and `src/composition/`); `prompt.ts` holds the retry/confirmation rules over an injected `Terminal`, so they are tested without a pseudo-terminal. Expected-failure types live in `models/` when they cross layers (`DatabaseAhead`, `KeychainFailure`, `ClientConfigFailure`), and in the edge's own module when only that edge uses them (`terminal.ts`'s `PromptEnded`/`InvalidAnswer`); each carries a `code` from a zod enum, used via `.enum.*`. A handler imports no other `diplomat/*`: the database, the keychain and the client config files reach it through `CliIo`. |
| `diplomat/clientConfig/` | The base `diplomat/*` rule — in practice `controllers/deps.ts` (type-only: the `ClientConfigs` port it implements), `models/auth/signIn.ts` (`DEFAULT_PROFILE`, `PROFILE_ENV_VAR`) and `models/package.ts` (`PACKAGE_SPEC`). Never exits the process and never prints: each client's `run` returns a `Result<ClientSetupReport, ClientConfigFailure>` (`controllers/deps.ts`, `models/clientConfig.ts`) — the lines and warnings to print, or why a file could not be read or written — which the `setup` command prints and turns into an exit code. The throwing `node:fs` calls are wrapped once, at the top of `clients.ts`. Outbound adapter for the MCP clients' own configuration files (Claude Code, Claude Desktop, VS Code, Antigravity, Codex): `merge.ts` holds the pure merge helpers and the entry shapes, `clients.ts` the file reads/writes (`node:fs`, `node:os`) and the per-client instructions. |
| `src/composition/*` — composition root, per flow | The only code that imports across `diplomat/*` submodules to wire edges to controllers, deps and the effect runner; `main.ts` only dispatches (CLI, stdio, http) and each flow's module is loaded lazily, only when that flow runs. Nothing under `diplomat/`, `controllers/`, `logic/` or `models/` imports it: edges receive what they need by injection (`RunEffects`, `SignInInterpreter`, `StdioAuth`, `CliIo`, `ClientConfigs`). `composition/signIn/interpreter.ts` is the shell capability that executes the sign-in protocol's effects — through the controllers, the injected `RunEffects`, `SignInStore` and a page — and decides nothing (every rule is `logic/auth/signInFlow.ts`'s); it is not a controller (a controller returns `{ persist, response }` and never executes an effect) and imports no `diplomat/*` itself. |
| `diplomat/mcp/route.ts` → `diplomat/http/{bearer,principal}.ts` | **Documented exception**: `POST /mcp` is also an authorization point, so its route reads the request's `principal` (type-only), answers a short token with the same `rejectWithChallenge` the auth hook uses (`bearer.ts`, so the two can never word a `WWW-Authenticate` differently) and names the read scope for its route config (`READ_SCOPE`, `models/auth/scope.ts`). Decisions stay in `logic/auth/`. |
| `diplomat/http` → `logic/auth/`, `diplomat/mcp` → `logic/auth/` | **Documented exception**: the edges may call the pure *edge decisions* in `logic/auth/` — credential parsing (`bearer.ts`'s `credentialOf`, `acceptsBearer`), scopes (`scope.ts`: `hasScope`, `requiredMcpScope`, `scopeOfTool`), origins and challenges (`origin.ts`'s `resourceOrigin`, `bearer.ts`'s `bearerChallenge`), the metadata document (`bearer.ts`'s `protectedResourceMetadata`), and — for the stdio session — `signInFlow.ts`'s `pendingOf` and `message.ts`'s `notSignedInMessage` — because they decide at the boundary what to read from headers and body (or which words to say) and never touch I/O. Everything else stays behind a controller. |
| `diplomat/http/hooks/` | The base `diplomat/*` rule, which in practice also allows the pure `logic/` predicates a route module may call (`routes/currencyRates.ts` does too) — no I/O. `hooks/` holds cross-cutting request interceptors (today `hooks/auth.ts`), registered by `composition/http.ts` before any route; `routes/` holds the per-domain handlers. |
| `diplomat/db/seed/` | `models/` (types and runtime enums) — nothing outside `diplomat/db` imports `seed/` |
| `diplomat/mcp` → `diplomat/http/{routes,openapi}.ts` | **Documented exception**: `buildRouteDefinitions`/`buildOpenApiDocument` are deterministic, no-business-logic wire-schema-driven builders (their only module-scope effect is a one-time, idempotent `extendZodWithOpenApi(z)` zod-prototype patch) reused verbatim by both the REST route and the `fintrack://openapi` MCP resource — including under stdio transport, which never touches Fastify — so the two surfaces can't drift (ADR-013 Phase A). |

**Composition map** (`src/composition/*`, one module per concern; `main.ts` only dispatches):

| File | Wires |
| --- | --- |
| `runtime.ts` | Repos (`Deps`), the applier registry and the change bus over an open `Db` — shared by `boot.ts` and the temporary sign-in server |
| `auth.ts` | `prepareAuth` (HTTP `auth`, the stdio `signIn(profile, origin)`, setup-code announcement), `createAuthDeps`, `AUTH_APPLIERS`, `bindAuthRunEffects` |
| `boot.ts` | Open the database → bootstrap → runtime → `prepareAuth`: what every server start shares |
| `stdio.ts` | The stdio start: `StdioAuth` for `connectStdio`, the HTTP sidecar (loaded lazily), setup-code announcement, shutdown |
| `http.ts` | The HTTP surface — `buildHttpApp`, `registerHttpApp`, `startHttpSidecar`, and `runHttp` for `MCP_TRANSPORT=http`; the only place Fastify is imported |
| `cli.ts` | The command mode: `defaultCliIo` and the `Shell` (database, auth deps, per-profile sign-in) |
| `signIn/interpreter.ts`, `signIn/server.ts`, `signIn/wiring.ts` | The sign-in executor; the temporary `/ui/connect` page; `createSignInFor`, the one factory that derives the keychain account, opens the store and lazily starts that page |

| `controllers/transaction/{core,read,bulk}.ts` | **Narrower than `controllers/` above (ADR-016)**: same base rule, but additionally must NOT import `logic/bill.js`, `deps.bills`, or anything from `controllers/creditCard/*`/`controllers/account/*`/`models/creditCard.ts`/`models/account.ts` — not even a type-only import (enforced: `rg "logic/bill\|deps\.bills" src/controllers/transaction/` and `rg "creditCard|controllers/account" src/controllers/transaction/ src/models/transaction.ts` each match only the header comments that document this rule — no actual import or usage) — this is the shared transaction core (row integrity, category resolution, generic patch/delete primitives, cross-cutting reads) that aggregates depend on, never the reverse. `bulk.ts` (ADR-017 step 2, ADR-022 step 3) makes **no** ownership decision at all — unlike its predecessor `createTransactionsBulk` (which delegated the account-vs-card dispatch to a composition-root router), single-source statement imports fix ownership by construction: whichever aggregate importer (`importCardStatement`/`importAccountStatement`) built the plan already knows which one card/account every line belongs to. `bulk.ts` is pure: `defaultStatementLines` defaults each line's `date` and stamps on the whole import's `rawInput` (the idempotency key is no longer defaulted here — each line's own single-add flow derives it, ADR-029 Phase 2b); `buildBulkResult` shapes the shell's per-line `SequenceOutcome`s back into the `BulkResult` contract. Both are typed purely against the core's own generic `StatementLine`/`ClassifiedUpsertResult`, with no card- or account-shaped field baked into either signature. `bulk.ts` never runs anything itself — each aggregate importer hands the shell a `StatementImportPlan` (defaulted lines + a `flowFor` closure factory), and the MCP/REST handler runs it through `runEffectsSequence` (see `docs/write-path.md`). |
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

Database: encrypted libSQL file (`fintrack.db`) opened via `@libsql/client` (async) with `drizzle-orm/libsql`. Schema defined in `src/diplomat/db/schema.ts`; migrations generated by `drizzle-kit` and applied at startup via `migrate()`. **Key resolution order** (`resolveEncryptionKey`, `diplomat/db/driver.ts`): `FINTRACK_DB_KEY_FILE` (path to a file holding the key, e.g. a Docker secret at `/run/secrets/fintrack_db_key`; trailing newline trimmed) → `FINTRACK_DB_KEY` (env var) → OS keychain (`@napi-rs/keyring`, key generated on first run). Setting both the file and the env var is a config error (ambiguous source). All sources share one 64-hex validator (`EncryptionKey`, `config.ts`). The log line names the source used, never the key. If no file/env key is set and the keychain is unavailable, startup fails with an actionable message (`openssl rand -hex 32` → file or env var); the key is never written to the `DB_PATH` directory. `@napi-rs/keyring` is loaded by dynamic import on the keychain path only — the file/env paths never load the native module.

**Concurrency posture (ADR-024).** `openDatabase` (`diplomat/db/driver.ts`) asserts `PRAGMA journal_mode = WAL`
(best-effort — falls back to rollback-journal with a `console.warn` if unsupported by the target build) and
`PRAGMA busy_timeout = 5000` (unconditional; busy_timeout is per-connection) on every open, before returning the
Drizzle handle. WAL lets the HTTP sidecar's reads proceed without blocking the writer; busy_timeout makes a
contended writer wait for the lock instead of throwing `SQLITE_BUSY` immediately — the case that matters when
more than one stdio server (ADR-007, spawned per client) holds a connection to the same file at once.
`isSqliteBusy` (bound as the engine's `isTransientContention`, `docs/write-path.md`) makes `SQLITE_BUSY` retryable as
defense-in-depth for contention that outlives the timeout. **WAL sidecar files** (`fintrack.db-wal`, `fintrack.db-shm`) appear beside the DB file — back up or copy
the database as a set with them, or checkpoint (`PRAGMA wal_checkpoint`) first.

Every mutable entity table below also carries `version INTEGER NOT NULL DEFAULT 0` (not shown per-line) —
the optimistic-concurrency token `runEffects` uses in its versioned unit-of-work mode (ADR-021 / `docs/write-path.md`;
ADR-022). On the zod side this token has a single declaration home: the package's `PersistenceMeta`/
`withPersistenceMeta` (engine-level, not FinTrack domain) — every `XxxEntitySchema`/`Raw*ViewSchema` is `withPersistenceMeta(XxxSchema)` rather than a
per-entity hand-written `.extend({ version: ... })`. **`version` never appears on a public model/wire shape** —
that invariant's single source is `PersistenceMeta`: the pure domain model (`XxxSchema`) stays unchanged, so
`Create*`/wire/out/tool-input shapes derive from it with no `.omit`s.
`currencies`, `merchants`, `merchant_category`, and `transaction_tags` do not — they are reference/join tables,
not aggregates a flow returns as a `Persistable`.

```
currencies          (code PK, symbol, name, decimals DEFAULT 2 — BRL/USD=2, USDC=6, BTC=8,
                     ADR-026 Phase 1; fiat + crypto, purely additive)
currency_rates      (id PK, from_code FK→currencies, to_code FK→currencies, rate REAL,
                     as_of TEXT, source TEXT?, version — UNIQUE(from_code, to_code), upsert-latest,
                     not a history log; agent/scheduler-supplied — the backend never fetches rates
                     itself (local-first, ADR-004/005); ADR-026 Phase 2)
accounts            (id PK, name, type: checking|savings|wallet|investment|credit,
                     initial_balance, currency FK→currencies, user_id, version)
credit_cards        (id PK, name, currency FK, closing_day, due_day, limit_amount?,
                     account_id FK→accounts, payment_account_id FK→accounts, user_id, version)
categories          (id PK, name, kind: expense|income|both, parent_id FK→self, names JSON?,
                     user_id? — null = a shared default, version)
merchants           (key PK — a shared dictionary of normalized names, never listed)
merchant_category   (merchant_key FK, category_id FK, weight, origin: rule|history, user_id? — no PK;
                     UNIQUE(merchant_key, category_id) WHERE user_id IS NULL, and
                     UNIQUE(user_id, merchant_key, category_id) WHERE user_id IS NOT NULL;
                     CHECK origin = rule ⇔ user_id IS NULL)
tags                (id PK, name, user_id, version — UNIQUE(user_id, name))
bills               (id PK, credit_card_id FK, month, year, close_date, due_date,
                     status: open|closed|paid, payment_transaction_id FK→transactions?, user_id, version —
                     UNIQUE(credit_card_id, month, year))
budgets             (id PK, category_id FK→categories — the budgeted node itself, a top-level
                     category or sub-category, limit_amount, currency FK, period: monthly, user_id, version —
                     UNIQUE(user_id, category_id, currency, period); Feature Design 015 phase 1)
transactions        (id PK, description, amount, type: expense|income|transfer,
                     status: pending|effective DEFAULT effective,
                     date, currency, source: mcp|rest|import, idempotency_key,
                     classification_method, confidence, raw_input?, note?,
                     from_account_id FK, to_account_id FK,   ← transfer uses both (ADR-002)
                     credit_card_id FK, bill_id FK, category_id FK, subcategory_id FK,
                     merchant_key FK, user_id, version —
                     UNIQUE(user_id, idempotency_key),
                     INDEX: (status, date) — supports scheduling queries; (user_id, date))
transaction_tags    (transaction_id FK, tag_id FK — composite PK; no owner column: a link is owned
                     through its two parents, which are always the same user's)
recurring_rules     (id PK, description, amount, type, period, next_due, currency,
                     account_id FK, category_id FK, merchant_key FK, user_id, version — Feature Design 017;
                     null on rules created before the migration, no backfill)

settings            (id PK DEFAULT 'singleton', version — instance-wide settings; nothing is stored
                     here today, a person's preferences live in user_settings)
user_settings       (user_id PK FK→users, locale: en|es|pt DEFAULT en,
                     locale_source: default|inferred|explicit DEFAULT default,
                     base_currency FK→currencies? — nullable, unset means "derive from locale"
                     (pt→BRL, en/es→USD; `logic/locale.ts`'s `resolveBaseCurrency`), explicitly
                     settable via `set_base_currency` (ADR-026 Phase 2), version — a user with no row
                     has the defaults)
dashboards          (id PK, name, html (nullable), source: inline|file DEFAULT inline, path (nullable),
                     updated_at, user_id? — null = a bundled default, version — ADR-013 Phase A, id normalized in
                     Feature Design 013 Phase 1, source/path added ADR-027 Phase 2; CHECK enforces exactly one of
                     html/path per source, and source = file ⇔ user_id IS NULL;
                     UNIQUE(name) WHERE user_id IS NULL, UNIQUE(user_id, name) WHERE user_id IS NOT NULL;
                     see § Dashboards / `/ui` surface)

users               (id PK, username UNIQUE? — stored normalized (trimmed, NFKC, lower-cased), null until the owner
                     is claimed, password_hash? (argon2id PHC string, null until claimed),
                     role: admin|member, created_at, disabled_at?, version)
sessions            (id PK, user_id FK→users ON DELETE CASCADE, token_hash UNIQUE — sha256 of the cookie
                     token, never the token — created_at, last_seen_at, expires_at, version)
access_tokens       (id PK, user_id FK→users ON DELETE CASCADE, kind: pat|stdio (default pat — what minted it: a
                     person at the token page, or the stdio sign-in flow), client_name? and profile? (a stdio
                     sign-in's self-reported client and its `FINTRACK_PROFILE`; null for a PAT), name,
                     token_hash UNIQUE — sha256 of the `ftk_…` token, never the token — prefix (`ftk_` + first 6
                     chars of the random part, display only), scopes JSON array of `Scope`
                     (`fintrack:read`|`fintrack:write`), created_at, last_used_at?, expires_at? (always set for a
                     stdio sign-in), revoked_at? (the row is kept on revoke), version)
client_grants       (id PK, device_code_hash UNIQUE — sha256, the plaintext lives only in the asking process —
                     user_code (normalized, 8 Crockford symbols; UNIQUE among `pending` rows only, a partial
                     index), client_name, client_version (as the client reported them), profile, channel:
                     stdio|cli (who asked — decides whether "this session only" is offered), hint_access? and
                     hint_duration? (what `fintrack login` would like pre-selected), status:
                     pending|approved|denied|redeemed|expired, user_id? FK→users ON DELETE CASCADE (whoever
                     approved; null until then), scopes? JSON array of `Scope` and duration?
                     (session|24h|7d|30d), both set by the approval, created_at, approved_at?, expires_at
                     (created + 10 min), version)
setup_codes         (id PK — the single fixed row `SETUP_CODE_ID`, replaced in place on each issue, code_hash UNIQUE — sha256, never the code — created_at, expires_at, used_at?,
                     version)

transactions_fts    VIRTUAL TABLE fts5(description, content='transactions')
                    — kept in sync via INSERT/UPDATE/DELETE triggers
```

### Tenancy (ADR-033 §5)

Isolation is logical (row-level) inside one encrypted database — not cryptographic: whoever holds the key and the volume
can read every user's data. **user_id** is on every user-owned row; the map says which rows are whose:

| Kind | Tables | Rule |
| --- | --- | --- |
| **Owned** | `accounts`, `credit_cards`, `bills`, `transactions`, `tags`, `budgets`, `recurring_rules` (`user_id` NOT NULL, FK RESTRICT); `user_settings` (PK, FK CASCADE); `transaction_tags` (via its parents) | Reads see only the user's rows; writes are stamped with and confined to the user. |
| **Shared default** | `categories` (the seeded `cat-*`), `merchant_category` `origin = rule`, `dashboards` `source = file` (`user_id` NULL) | Every read returns *shared + own*; nobody can rename or delete one (`SHARED_DEFAULT_READ_ONLY_MESSAGE`, `models/tenancy.ts`, one validation error from every tool and route). A dashboard saved under a default's name is the user's own copy and replaces the default for them alone. |
| **Shared dictionary / reference** | `merchants`, `currencies`, `currency_rates`, `settings` (singleton) | No owner. Any signed-in user with write scope refreshes exchange rates (market data); the merchant dictionary is never listed across users. |

**`depsFor(principal)` / `runEffectsFor(principal)`.** The composition root (`composition/runtime.ts`) builds, per request and
by partial application, a `Deps` whose repos are already bound to `principal.userId` (`accountsRepo(db, userId)` …),
and a `RunEffects`/`RunEffectsSequence` whose applier registry is built for that user (`ownedTableApplier(table, userId)`:
insert stamps `user_id` — a flow cannot choose or change an owner —, update and delete add `AND user_id = :me`, so another
user's row, and a shared default, simply do not match and the write fails as a stale version → `conflict`; the idempotency
conflict target is `(user_id, idempotency_key)`). Nothing about "the current user" is stored between requests: no global, no
async-local storage; the only per-user cache is the locale cache, keyed by user (`diplomat/db/localeCache.ts`;
`FINTRACK_LOCALE` still overrides for everyone). Controllers are unchanged in shape — they receive the scoped `Deps` and
return effects — and no repo method takes a `userId`; unscoped access exists only in composition (bootstrap, seeding,
migrations, `authRunEffects` for the identity flows, `publicDeps` for the unauthenticated health probe). An edge handler
without a principal throws (HTTP `ScopeOf`, MCP `McpContext.as`) — fail closed.

**Resolvers** (`controllers/resolve.ts`) resolve only within the scoped deps, so another user's id or name is *not found* —
never *forbidden* — and the candidates an ambiguous/not-found error lists are the caller's own rows plus the shared
defaults. **Classification** reads the shared `rule` edges plus the caller's own `history` edges (summed per
(merchant, category), as one row's weight was before); a correction writes a `history` edge for the caller.

**The change bus** (`composition/changeBus.ts`, `UserChangeBus`) carries `{ userId, entities }`; the scoped runner publishes as
its user, the identity runner as `null` (instance bookkeeping no dashboard hears). `/ui/events` forwards only events whose
`userId` is the stream's session user.

**Data-rewriting migration `0021_tenancy_data`** rebuilds the owned tables with `user_id` (backfilled to the owner, looked up —
a missing owner aborts), keeps the 15 seeded categories, `rule` edges and `file` dashboards shared, moves the singleton's
preferences to the owner's `user_settings` row, and — inside the same transaction as the pre-migration `.bak` snapshot —
checks that no owned row has a null or unknown `user_id` (`diplomat/db/tenancyIntegrity.ts`); a violation rolls the whole
migration back and the process refuses to start. A guard statement aborts the migration if foreign-key enforcement is on
(dropping `transactions` would otherwise cascade away `transaction_tags`).

Repos live in `src/diplomat/db/repos/`; each accepts a `Db` (`LibSQLDatabase<typeof schema>`) injected from `composition/boot.ts`. Drizzle query builder is used for simple CRUD; `db.all(sql\`...\`)` for joins and FTS5 searches. All queries parameterized — never string-interpolate user input.

Seed data (currencies, categories, merchant rules) lives in `src/diplomat/db/seed/` (ADR-008). Seed-only types (`DefaultCategoryId`, `MerchantRule`) live there too — the domain never imports seed.

## Invariants (violations are bugs)

1. **Idempotency**: every Transaction write uses `UNIQUE(user_id, idempotency_key)` + `onConflictDoNothing()` (the key is unique per user — the derivation names no user, so every existing key stays valid and two users importing the same statement do not collide); `rowsAffected === 0` means duplicate — return the existing row, `created: false`. The key is engine metadata carried on the insert `Persistable`'s own `idempotencyKey` field (ADR-029 Phase 2) — never a field of the `Transaction` domain model — and the applier writes it onto the physical column (fixed by convention, ADR-029 Phase 2b) at insert time; see `docs/write-path.md` for the full mechanics. The key itself is domain-derived, never caller-supplied (ADR-029 Phase 2b): `logic/transaction.ts#deriveIdempotencyKey` hashes (as a `JSON.stringify`-serialized array, never a plain string-joined concatenation — a caller-supplied `discriminator` is otherwise-unconstrained text, so a plain separator risks two different field combinations serializing to the same string) the write's full deterministic identity — funding source (account/card id), a transfer's destination account (`counterpartyId`, unset for a movement/purchase — needed so two transfers sharing source/date/description/amount but different destinations don't collide), a card purchase's resolved bill cycle (`billPeriodKey`, `month-year`; unset for a movement/transfer — an explicit `billMonth`/`billYear` override can target a different cycle than an otherwise-identical purchase), type, currency, date, normalized description, and the amount rounded (via `roundToDecimals`, never a raw `.toFixed`) to its own currency's decimals (not a flat 2, so a USDC/BTC amount differing only past the 2nd decimal never collides with another line's) — plus an optional caller `discriminator`, the escape hatch for a genuinely-distinct transaction that would otherwise derive an identical key. Every insert-shaped flow (single-add and bulk import alike, since bulk reuses the same single-line flows) resolves its own real funding source and currency before deriving the key, so an unattached statement's per-item `currency` override correctly drives that line's own decimals rounding too; bulk import caches the currencies-list read once per batch (mirroring the existing per-batch locale cache) rather than once per line. **One-time key-format discontinuity**: a statement re-imported after Phase 2b landed won't dedup against pre-existing readable-format keys — accepted at personal scale, no backfill.
2. **Transfers** are `type: 'transfer'` with both `from_account_id` AND `to_account_id` set (ADR-002); summary/classification queries MUST exclude them (`t.type != 'transfer'`).
3. **Currency**: transactions denormalize the account/card currency at write time; aggregations group per currency, never convert — **spend stays per-currency; this does not change.** `CurrencyCode` is BRL/USD/USDC/BTC — crypto is first-class alongside fiat, purely additive. Money-amount rounding in `logic/` (`summarize`, `shapeAggregateResult`, and `logic/correlations.ts`'s five `shape*`/`detectRecurringCadence` functions) is currency-decimals-aware (`roundToDecimals`, `logic/money.ts`) — a currency's own `decimals` (fiat 2, USDC 6, BTC 8) is looked up via `decimalsLookup` from the `currencies` reference list, never hardcoded to 2, so a native BTC/USDC amount isn't flattened to fiat precision. Ratio/percentage fields (`deltaPct`, `share`, `cumulativeShare`) are unaffected — they round to a fixed precision regardless of currency, since they were never money. **The no-implicit-conversion invariant is relaxed, precisely, for read-time valuation only:** a `currency_rates` table (`(from_code, to_code)` pairs, upsert-latest, self-contained + `as_of`-stamped) is agent/scheduler-refreshed — **the backend makes zero external calls to populate it**, preserving the local-first posture; `set_exchange_rate(s)`/`list_exchange_rates` are the write/read tools. `user_settings.base_currency` (per user) names the default valuation target, resolved the same way locale resolves (explicit override wins, else derived from locale: pt→BRL, en/es→USD — `logic/locale.ts`'s `resolveBaseCurrency`), settable via `set_base_currency`. `logic/currencyRate.ts`'s `convert` is a pure `amount × rate` helper: `from === to` is always identity (rate 1, never stale); a missing pair reports `noRate: true` rather than fabricating a value; staleness is per-class — a pair touching USDC/BTC on either side uses a tighter window (`CRYPTO_RATE_STALE_HOURS`, default 1h) than a pure-fiat pair (`FIAT_RATE_STALE_HOURS`, default 24h), both configurable via env (`config.ts`). **`get_account_balances` is `convert`'s per-item consumer:** valuation correlates two aggregates (`accounts` × `currency_rates`), so it's controller-orchestrated, never a repo join — the `accounts` controller fetches account balances (its own repo), every stored rate (`currencyRates` repo, its own aggregate), the caller's `user_settings.base_currency`, and the currencies reference list, then hands them to `logic/currencyRate.ts`'s `valueAccount`/`consolidateNetWorth` (pure). Each balance whose currency differs from the base gains an optional `converted` block (`{ baseCurrency, value, rate, asOf, stale }`) when a rate is on file; same-currency is `convert`'s own identity case (rate 1, never stale); a missing rate omits `converted` entirely rather than fabricating a value. A top-level `consolidatedNetWorth` (`{ baseCurrency, total, excluded }`) sums every `converted.value` across the response; an account with no `converted` block is listed in `excluded` and left out of `total`. Neither repo (`accountsRepo`/`currencyRatesRepo`) ever joins the other aggregate's table.

**Opt-in converted grand totals on per-currency reads (Feature Design 021):** `get_spending_summary`, `get_budget_status`, `find_correlations`, and `aggregate_spending` all accept an optional `displayCurrency` (`CurrencyCode`); omitted, each response is unchanged (per-currency lines only, spend stays per-currency by default). Provided, the owning controller fetches its own per-currency amounts (its own repo, unchanged) and every stored rate (`currencyRatesRepo`, its own aggregate), then hands both to `logic/currencyRate.ts`'s `consolidateInCurrency` — the generalized form of `consolidateNetWorth`: it converts a set of per-currency amounts against `rates` itself (rather than taking pre-converted items), sums the convertible ones, and returns `{ total, stale, asOf, excluded }`. The response gains a top-level `converted` block (`{ displayCurrency, total, stale, asOf, excluded }`); a currency with no rate to `displayCurrency` is listed in `excluded` (`{ currency, reason: "no_rate" }`) and left out of `total`, never fabricated; `stale` is true if any contributing rate is stale, `asOf` is the oldest contributing rate's timestamp (`null` when nothing converted). Controller-orchestrated per ADR-028, same as account valuation — neither the transactions repo, the budgets repo, nor the correlations repo ever joins `currency_rates`. `get_spending_summary` converts `expenses` per currency; `get_budget_status` converts **committed** (effective + pending) spend per currency, computed once per currency directly from the underlying spend matched by at least one budget (`logic/budget.ts`'s `budgetedCommittedByCurrency`) rather than by summing per-line `committed.amount` — a spend row counted toward both a sub-category budget and its rolled-up parent budget contributes to the total only once. `find_correlations` attaches its own `converted` block **per mode**, only where that mode reports per-currency money: `spending_shifts` converts the reference month's effective expense spend per currency (`logic/correlations.ts`'s `currentSpendByCurrency`, summed over every row regardless of `minDeltaPct` filtering); `budget_fit` converts committed spend matched to a budget via the same `budgetedCommittedByCurrency` `get_budget_status` uses (over a fresh `spendByCategory` read for the reference period, not the mode's own `spendByCategoryWindowed` current/baseline pair), so the two surfaces agree; `merchant_concentration` converts each currency's `categoryTotal`, summed once via `logic/correlations.ts`'s `merchantSpendByCurrency` rather than per merchant line (avoiding a double count). `recurring_candidates` is excluded — its candidates are proposed rules, not per-currency spend totals, so `displayCurrency` is a no-op there. `aggregate_spending` converts each currency block's own `total` (one value per block, not per row — rows already sum to the block total) and only attaches `converted` when `metric` is `sum`: a block total is then a genuine money quantity to convert and cross-sum, while `count` (a transaction count) and `avg` (a sum of per-group averages) are not coherent cross-currency amounts, so `displayCurrency` is a no-op for those metrics (omitted, not an error).
4. **Balances are derived**, never stored: `initialBalance + income − expenses + transfers in − transfers out`. **Only `effective` transactions count** — pending transactions never affect the current balance. Projection (balance + pending-through-date) is opt-in via `projectedAsOf` on `get_account_balances`.
   - **Effective-only invariant (Feature Design 001)**: `get_account_balances` and `get_spending_summary` MUST filter `status = 'effective'`. Projection queries explicitly include `pending`. Classification ignores status. This is enforced in `diplomat/db/repos/` — violations are bugs.
5. **Classification via merchant_category**: normalized description → `merchants.key` → strongest `merchant_category` edge; user corrections increment `weight` (`onConflictDoUpdate`). **Recurring rules carry a merchant too (Feature Design 017)**: `create_recurring` resolves `recurring_rules.merchant_key` from an explicit `merchant` (stored as given, normalized) or, failing that, the same `merchant_category` match-first precedence `planAccountMovement` uses for transactions — reusing an already-learned key over a fresh full-description normalize — so a rule reinforces the same merchant identity a matching transaction would; every occurrence `apply_due_recurring` materializes inherits the rule's `merchant_key`, so recurring spend participates in merchant concentration and classification like any other transaction. Rules created before the migration have `merchant_key = null` (no backfill — `normalizeMerchant` can't be faithfully reproduced in SQL) until re-saved. This `merchant_key` is what `find_correlations`'s `recurring_candidates` mode (Feature Design 016 phase B) excludes on exactly: a candidate merchant already backing a rule is filtered out in SQL via `t.merchant_key NOT IN (SELECT merchant_key FROM recurring_rules WHERE merchant_key IS NOT NULL)` — a pre-017 rule (`merchant_key = null`) doesn't match and so can still surface as a candidate until re-saved.
6. **Category kind must match transaction type**: `expense` transactions may only use `expense` or `both` categories;
   `income` may only use `income` or `both`. Enforced in `controllers/transaction/core.ts`'s `resolveCategory`/
   `resolveSubCategory` (shared by every movement path) via `isCategoryKindAllowed` (predicate in `logic/transaction.ts`).
7. **Sub-category always paired with parent**: `subcategory_id` set → `category_id` must also be set to the sub-category's parent. Enforced by a `CHECK` constraint and in `controllers/resolve.ts`.
8. **Card purchases are funded by the card's internal liability account (debt).** Bill payment is a canonical transfer (ADR-002) from a bank account to the card account, excluded from spending summaries — never an expense (double-count). `pay_bill` creates it, links it via `bills.payment_transaction_id`, and marks the bill paid. Value enters a `credit` account only via `pay_bill`. **A `paid` bill has at most one payment transfer** (Feature Design 011): created only by `pay_bill`, removed only by `revert_bill_payment` (which deletes the transfer and flips `paid → closed` — the exact inverse; both are idempotent no-ops outside that transition). A bill marked paid with a non-positive total has no transfer (`payment_transaction_id` absent) — revert still flips it to `closed`. **A `paid` bill is composition-immutable** (Feature Design 012): `add_card_purchase` rejects landing a transaction on a `paid` bill (whether by explicit `billMonth`/`billYear` or plain cycle auto-assignment), `update_card_transaction` rejects moving a transaction off a bill that is currently `paid` (and rejects editing the bill-payment transfer itself outright — ADR-017), and `delete_card_transaction` rejects any transaction whose `bill_id` points at a `paid` bill — not just the payment transfer (which is itself always covered, since its own `bill_id` is the bill it paid, even though the transfer itself has no `credit_card_id`; ADR-017's union ownership rule — `cardId` **or** `billId` — routes the payment transfer to `update_card_transaction`/`delete_card_transaction` by construction, not by a composition-root lookup). Every case points the caller at `revert_bill_payment`; none of these guards ever auto-revert. `transactions.bill_id` is assigned automatically by cycle (`billPeriodFor`) or, when given, by an explicit `billMonth`/`billYear` (`billPeriodForCycle`) — either way it is set on the transaction row **at insert/update time itself** (`controllers/creditCard/transaction.ts`'s `resolveBillWrite` decides insert-a-fresh-`open`-bill vs. version-guarded-touch-the-existing-one as a `Persistable`, applied atomically with the transaction write by the shell; there is no separate "attach" step and so no orphan row to self-heal) — and is readable on `TransactionView` as `billId`. A transaction can only ever belong to a bill of its own card (structural: there is no way to change a transaction's card via `update_card_transaction`). All of this policy lives in the credit-card aggregate (`controllers/creditCard/transaction.ts`), never in the transaction core (ADR-016). **A card's internal account name always tracks the card's own name** (Feature Design 014 phase C): `Card: {name}` (ADR-010), kept in sync by `update_credit_card`'s rename — a two-entity update batch renaming the card and its internal account together, atomically. Nothing else ever renames that account independently.
9. **Encryption on by default**: the database is always opened with an encryption key (from `FINTRACK_DB_KEY_FILE`, `FINTRACK_DB_KEY`, or the keychain). Opening without a key is a startup error. The key is never logged or committed (ADR-005).
10. Decode at the boundary: every external input and SQL row is zod-parsed before entering the domain.
11. **Dynamic query structure is composed only from whitelisted enum-keyed SQL fragments** (ADR-011); caller-supplied values are always parameter-bound; caller text is never concatenated into SQL. Exhaustive `Record<Enum, Fragment>` maps in `diplomat/db` are the only source of structural SQL; `assertNever` / TS exhaustiveness guards unmapped keys at compile time.
12. Behavior changes require tests: domain and boundary behavior updates must include unit tests in the same change (success and expected-failure paths).
13. **Category identity is the slug/id, not the localized name** (Feature Design 002, ADR-009). Default categories carry a JSON `names` column (`{"pt":"…","es":"…"}`); display name is resolved at read time as `names?.[locale] ?? name`. Merchant rules and classification key on the slug, never the display name. User-created categories have `names = null` and keep their literal `name`.
14. **Locale is AI-determined, stored, env-overridable** (Feature Design 002). `user_settings.locale` (`en|es|pt`, one row per user), default `en`. Resolution: `FINTRACK_LOCALE` env → the caller's `user_settings.locale` → `'en'`. `set_locale` with `source: inferred` is rejected when `locale_source` is `explicit`.
15. **Seed is isolated (ADR-008).** Seed data lives in `diplomat/db/seed/`; the domain (`models/`, `logic/`, `controllers/`) never imports it. The app boots and works on an empty (unseeded) DB.
16. **Unbounded collections page by keyset cursor with the paginated envelope (ADR-014).** `search_transactions` (first mover) returns `{ items, nextCursor?, total? }`; `ORDER BY` is composed only from a whitelisted enum-keyed column map (`ORDER_BY_COLUMN` in `wire/db/transactions.ts`, turned into SQL only in `diplomat/db/repos/transactions.ts`), the same mechanism as invariant 11 applied to ordering — caller text never reaches `ORDER BY`. Cursors are opaque, zod-validated at the boundary, and bound to the `sort`/`dir` that produced them (a mismatch is a `validation` error). `total` is opt-in (`includeTotal`) — an extra same-WHERE `COUNT(*)`, never paid by sequential "walk until no `nextCursor`" consumers. Small, cycle-bounded `list_*` endpoints stay plain arrays; the envelope is the signal a collection can page.
17. **No god write flows for any transaction mutation (ADR-017, complete; ownership mechanism revised by ADR-020).** The only cross-cutting transaction surface is the read side (`search_transactions`, `get_spending_summary`, `aggregate_spending`, account balances); every write is an aggregate-specific entry point that validates ownership itself and never dispatches by inspection — there is no composition-root router. Update/delete: `update_card_transaction`/`delete_card_transaction`, `update_account_transaction`/`delete_account_transaction`. **Ownership is resolved by account type, not by a core structural discriminator (ADR-020), and each aggregate asks its own question rather than sharing one judgment:** `controllers/resolve.ts`'s `resolveLegAccounts` is a neutral I/O helper (resolves the accounts referenced by a transaction's leg(s) — `accountId`/`toAccountId` — via `deps.accounts.findById`; makes no ownership judgment of its own). The credit-card aggregate's own `assertCreditAccountLeg` (`controllers/creditCard/transaction.ts`) asks "is a leg `credit`" (ADR-010) — true for a card purchase (`accountId` **is** the card's own internal account) and the bill-payment transfer (`toAccountId` **is** that same account). The account aggregate's own `assertAccountOwnedLegs` (`controllers/account/transaction.ts`) asks the different, positive question "is every leg one of *my* types" against `logic/account.ts`'s `isAccountOwnedType` (an enumeration of `checking`/`savings`/`wallet`/`investment` — the account domain's own scope, not the negation of `credit`; vacuously true for an unattached movement with no legs at all). Neither aggregate reuses or negates the other's predicate, and the core owns no ownership discriminator at all. A wrong-tool call is rejected with a `validation` error naming the correct tool (`transactionErrors.wrongTool`, raised by each aggregate's own guard) — a guard, not a redirect the server performs on the caller's behalf. Card purchases and the bill-payment transfer are card-owned; regular movements and transfers are account-owned. Transfer *mutation* policy (`guardTransferMutability`, the `transferTypeImmutable`/`transferCategoryRejected` errors) lives wholly in the account context (`logic/account.ts`, `models/account.ts`) — the credit-card aggregate never reasons about transfer invariants; its one transfer (the bill-payment transfer) is blocked outright by its own bill-process guard — a `validation` error naming `revert_bill_payment` — not by transfer-immutability. Bulk: `import_card_statement`/`import_account_statement` are single-source — a statement belongs wholly to the ONE card/account the caller named, so there is no per-line owner to decide; the shared `controllers/transaction/bulk.ts` helpers (`defaultStatementLines`/`buildBulkResult`) only default per-line fields and shape the result, making no ownership decision.
18. **The transaction core's movement schema is minimal (ADR-019 step 1).** `CreateTransactionSchema`/`UpdateTransactionSchema` (`models/transaction.ts`) carry only genuinely-shared ledger vocabulary (description, amount, type, status, date, category/subCategory, currency, discriminator, rawInput, note, tags) — they name no sibling context's field. Each aggregate `.extend`s the core up with its own vocabulary rather than the core carrying the union for aggregates to `.omit` down: `AddCardPurchaseSchema` (`models/creditCard.ts`) adds `card`/`billMonth`/`billYear`; `UpdateCardTransactionSchema` adds `billMonth`/`billYear` (bill reassignment — no `card` field, since a transaction's card can't change on update); `AddAccountMovementSchema`/`UpdateAccountTransactionSchema` (`models/account.ts`) add `account`. The field-tied bill errors (`billPeriodIncomplete`, `billAssignmentRequiresCard`) moved with the fields to `cardErrors`. One documented exception: `UpdateCardTransactionSchema` also `.extend`s `account` (rather than leaving it out) purely so `controllers/creditCard/transaction.ts`'s `updateCardTransaction` can keep rejecting it with its dedicated `cardErrors.accountChangeRejectedForCard` message — omitting the field would replace that message with a generic `.strict()` unrecognized-key error, a worse-not-better outcome. Transfer is the boundary case: the transfer *row kind* (`TransactionType.enum.transfer`, balance/summary math, `TransactionView.toAccountId`) stays core because the shared read/balance side is structurally defined over it (`resolveEffectiveType` stays in `logic/transaction.ts`); transfer *policy* (`guardTransferMutability`, the `transferTypeImmutable`/`transferCategoryRejected` errors) lives in the account context (ADR-020). Currency resolution lives in `logic/money.ts` (context-neutral: a `{ currency } | null` funding source plus the input override); `assertBillPeriodPaired`/`withBillId` live in `logic/bill.ts` (credit-card context).
19. **Every write flow returns its writes as data; none perform them (ADR-021/022/023, complete repo-wide).**
    A converted controller builds `Persistable`s and returns them in `persist` (or, for bulk import, a
    `StatementImportPlan` the shell runs through `runEffectsSequence`); it never calls a repo write method and
    never touches `Db`. **`deps` exposes no write method at all, for any entity** — every repo is read-only
    (queries and pure helpers only), and no domain rule survives as a SQL predicate in a repo. The package's
    `runEffects` (invoked from the MCP/REST handler) applies the batch through the ports FinTrack binds at the
    composition root (`composition/runtime.ts`): `diplomat/db/driver.ts`'s `createTransactionRunner(db)`, `sqliteErrors.ts`'s
    `isSqliteBusy`, and `models/error.ts`'s `conflict`. Only that adapter touches `Db`; `diplomat/db/effects.ts` is
    the SQLite `versionedTableApplier`. The conversion history, applier catalogue, and unique-race handling live in
    `docs/write-path.md` and ADR-021/022/023/030 — not here.
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

23. **Exactly one owner, created by migration, claimed — never created — by setup (ADR-033 §7).**
    Migration `0018_auth_identity` inserts one `users` row (`OWNER_USER_ID`, role `admin`, no username, no
    `password_hash`) on every database, fresh or existing, and touches no domain table; the owner is never created
    lazily at runtime. The owner is the "default user": stdio and every `disabled`-mode request act as it
    (`OWNER_PRINCIPAL`). `controllers/auth.ts`'s `claimOwner` is the only flow that gives it credentials and emits
    an `update` of the owner — **no flow inserts a `user`**, so no path can create a second, empty user a database's
    data doesn't belong to. A setup code exists only while auth is `required` AND the owner has no credentials.
    **Secrets are stored only as hashes:** passwords as argon2id, session tokens, access tokens (`ftk_…`) and setup codes as sha256 — the
    plaintext session token exists in the cookie, a plaintext access token on the one page that shows it at creation, and the plaintext code in one stderr line, nowhere else — and are never
    logged (the Fastify logger redacts `cookie`, `set-cookie`, `authorization`). **Safety copy:** before a migration
    listed in `diplomat/db/migrations.ts`'s `DATA_REWRITING_MIGRATIONS` runs against a database that already has
    applied migrations, `diplomat/db/safetyCopy.ts` snapshots it with `VACUUM INTO` while holding SQLite's write lock — `migrationBarrier.ts`'s `applyPendingMigrationsHolding` applies the pending migrations in that same `BEGIN IMMEDIATE` transaction (mirroring drizzle's libsql migrator and its `__drizzle_migrations` rows), so no other writer — even a process on an older release — can commit between the snapshot and the migration and be missing from the backup. The snapshot is written, encrypted under the same key, to `<DB_PATH>.pre-<migration>.bak` (standalone, mode `0600`,
    path logged to stderr); a brand-new database gets none. The copy and the migration run under a cross-process lock (`diplomat/db/migrationLock.ts`: an `EXCLUSIVE` transaction on a companion SQLite file `<DB_PATH>.migrate.lock` — OS-owned, so atomic and released when its holder dies), and "is it still pending?" is re-asked once the lock is held — so several stdio servers starting at once can neither interleave their copies nor back up an already-migrated file.

## Authentication (ADR-033)

Identity guards every surface: the HTTP surface (`/api`, `/mcp`, `/ui`) and the stdio channel. Authentication is **on
by default**; `disabled` is an explicit, loopback-only opt-out, and under it both HTTP and stdio act as the owner.
`docs/auth.md` is the operator guide; this section is the as-built structure.

**Config** (`config.ts`, validated together; invalid combinations are startup errors):

| Variable | Rule |
| --- | --- |
| `FINTRACK_AUTH` | `AuthMode` (`required` \| `disabled`). Default `DEFAULT_AUTH_MODE` (`models/auth/mode.ts`) = `required` for **every** run, loopback included. `isExposed` — a non-loopback `HOST`, or `PUBLIC_URL`, or a `TRUST_PROXY` other than `false`/`0` — no longer picks the default; it only rejects an explicit `disabled` on such an instance. |
| `PUBLIC_URL` | Optional `http(s)` **origin** (`new URL(v).origin === v`: no path, no trailing slash; empty = unset). `https` → cookie `Secure`. A CSRF expected origin. |
| `TRUST_PROXY` | Optional; `true`/`false`/hop count/address list → Fastify `trustProxy`. |
| `FINTRACK_PROFILE` | `ProfileSchema` (letters, digits, `.` `_` `-`, ≤ 64); default `DEFAULT_PROFILE`. Names which saved stdio sign-in a process uses. |
| `FINTRACK_TOKEN` | Optional personal access token a stdio process signs in with. Not judged at startup — the stdio session checks it on every call. |

`isLoopbackHost` (`common/net.ts`: `127.0.0.0/8`, `::1`, `localhost`) is the one loopback test, shared by config and the
CSRF origin check.

**Source map.** Authentication is a multi-file domain in `logic/` and `models/` (like `controllers/account/`): one file per concern, and an import
names the file — there is no barrel. Rules and their data sit side by side.

| Concern | `logic/auth/` (pure rules) | `models/auth/` (schemas, constants, types) |
| --- | --- | --- |
| Owner identity and the setup code | `owner.ts` | `owner.ts` (`UserRole`, `OWNER_USER_ID`, `UserEntitySchema`, `SetupCodeEntitySchema`) |
| Usernames, passwords, login inputs | `password.ts` | `password.ts` |
| Browser sessions | `session.ts` | `session.ts` |
| Access tokens (personal and stdio sign-ins) | `token.ts` | `token.ts` |
| Scopes | `scope.ts` | `scope.ts` |
| Who a request acts as | — | `principal.ts` (`Principal`, `PrincipalVia`) |
| Bearer credentials, challenges, Protected Resource Metadata | `bearer.ts` | `bearer.ts` |
| Origins: CSRF, the loopback guard, the sign-in link | `origin.ts` | `origin.ts` |
| Grants (the server side of a stdio/CLI sign-in) | `grant.ts` | `grant.ts` |
| Sign-in on the client side: keychain account, profile, env vars | `keychain.ts` | `signIn.ts` |
| The sign-in protocol (state, observations, effects, presentations) | `signInFlow.ts` | `signInFlow.ts` |
| Operator messages | `message.ts` | `message.ts` |
| Errors, mode, entity tags, time units | — | `errors.ts`, `mode.ts`, `entity.ts`, `time.ts` (`logic/auth/time.ts` holds the ISO↔millis helpers) |

**The hook and the principal.** `diplomat/http/hooks/auth.ts`'s `registerAuthHook` adds one `onRequest` hook on the root
Fastify instance, **before any route** (`composition/http.ts`'s `registerHttpApp` — ordering is wiring), so it also guards a request no route matched. It
sets `req.principal` (`models/auth/principal.ts`'s `Principal` = `{ userId, role, scopes, via, tokenId? }`; typed in `diplomat/http/principal.ts`).
`scopes` is a list of `Scope` (`fintrack:read`, `fintrack:write`; write implies read — `logic/auth/scope.ts`'s `hasScope`); `via` is
`session | token | owner | stdio` (`PrincipalVia`; `stdio` = a stdio sign-in, see below):

- auth `disabled` → `OWNER_PRINCIPAL` (every scope, `via: owner`), but only for a request that passes `logic/auth/origin.ts`'s `isLoopbackRequest` (a loopback `Host`, and a loopback `Origin` if one is sent — the DNS-rebinding/cross-site guard; otherwise `403 forbidden_origin` on every route). The `Authorization` header is ignored. No auth, token or metadata routes are registered;
- auth `required`, on `/api` and `/mcp` (`logic/auth/bearer.ts`'s `acceptsBearer`), **an `Authorization` header is authoritative** (`credentialOf`): it must be `Bearer ftk_…`, and `controllers/accessTokens.ts`'s `authenticateToken(sha256(token))` must find an unrevoked, unexpired token whose owner can log in — principal with the *token's* scopes, `via: token`. Anything else (another scheme, an unknown/revoked/expired token) is `401 invalid_token`, and **the cookie is never consulted** — a bad bearer does not fall back to a session. A bearer-authenticated request skips the CSRF check (no ambient credential);
- auth `required`, otherwise (no header, or any `/ui` path, where a bearer is never accepted) → `controllers/auth.ts`'s `authenticate(tokenHash)` on the `fintrack_session` cookie (every scope, `via: session`). No credential → `401` JSON `{ error: { code: 'unauthenticated' } }` **with a Bearer challenge** for `/api`, `/mcp` and anything outside `/ui`, or a `303` to `/ui/setup` (owner unclaimed) / `/ui/login?next=…` for `/ui`.

After authentication the hook checks **scope** against the matched route: `req.routeOptions.config.scope` (declared by `RouteDefinition.scope`, put into the Fastify route config by `mountRoutes`), falling back to `logic/auth/scope.ts`'s `defaultScopeForMethod` (GET/HEAD → read, else write) for a route that declares none, so an undeclared non-GET route fails closed (every shipped route declares its scope, pinned by a unit test). A short principal gets `403 insufficient_scope`. Whether a request may carry a bearer is decided from the route the router matched (`req.routeOptions.url`; the router decodes `/%61pi/…`), falling back to the raw path only for a request no route matched.

The only exemptions are `PUBLIC_ROUTES` (`diplomat/http/authPaths.ts`), matched on the route's **registered pattern +
method** (`req.routeOptions.url`), never the raw URL: `GET|HEAD /api/health`, `GET|HEAD|POST /ui/login`,
`GET|HEAD|POST /ui/setup`, `GET|HEAD /ui/assets/app.css`, and the two Protected Resource Metadata routes. A path with no route is protected. An integration test
enumerates every route Fastify registers (an `onRoute` listener attached before registration) and asserts each one
outside the list is rejected without a credential (and, outside `/ui`, with a challenge). Controllers still do not take the principal: the edge turns it into that user's scoped `Deps` (§ Tenancy), so a controller can only ever see the caller's data.

**Scopes — two sources, one rule.** REST: every `RouteDefinition` has a required `scope` (`READ_SCOPE`/`WRITE_SCOPE`,
`models/auth/scope.ts`); a unit test pins each to `defaultScopeForMethod`. MCP: every `registerTool` call declares
`annotations.readOnlyHint` (`diplomat/mcp/annotations.ts`'s `READ_ONLY`/`MUTATING`); `logic/auth/scope.ts`'s `scopeOfTool` derives
the scope from it (`true` → read, anything else → write) and `diplomat/mcp/scopes.ts`'s `guardScopes` is the one place
that reads it: it wraps `server.registerTool`, **throws if a tool lacks a boolean hint**, records name → scope
(`toolScopesOf`), and wraps each callback — and every resource and prompt callback, which need `read` — so it first asks
the transport's **`PrincipalGate`** (`diplomat/mcp/gate.ts`) who is calling. The gate answers `granted` (with the whole `Principal` — user, role, scopes, `via`, token id — on every transport, so a handler that needs to know who is calling reads it from one place),
`refused` (a structured `AppError`) or `not_signed_in` (plain instructions): HTTP's `authInfoGate` reads
`extra.authInfo` (`authInfo.ts`'s `principalOf` rebuilds the principal from it) and fails closed when it is absent or not a whole principal, stdio's gate is its `StdioSession`, and `ownerGate` serves an explicit
`FINTRACK_AUTH=disabled` run. A tool gets an `isError` result (JSON for `refused`, the plain text for `not_signed_in`); a
resource or prompt gets a JSON-RPC `InvalidRequest` error with the same text. `initialize` and the three list requests are
never wrapped. `POST /mcp`
enforces twice: its route is declared `read` for the hook, a `preHandler` reads the parsed JSON-RPC body
(`logic/auth/scope.ts`'s `requiredMcpScope`: any `tools/call` of a write tool — or of a tool it cannot place — in a message or batch
needs `write`) and answers `403 insufficient_scope` before any tool runs; the handler then hands the principal to the SDK
transport as `req.raw.auth` (`diplomat/mcp/authInfo.ts`'s `AuthInfo`: `token` = the access-token *id*, `clientId`
`pat:<id>` / `session` / `owner`, `scopes`), and each tool, resource and prompt re-checks it through `authInfoGate` (defence in
depth; a missing `authInfo` is refused). A unit test builds the whole MCP server and lists the read/write split.

**Challenges** (RFC 6750 §3, MCP authorization): `logic/auth/bearer.ts`'s `bearerChallenge` is the only place a `WWW-Authenticate`
value is built; `diplomat/http/bearer.ts`'s `rejectWithChallenge` resolves only the origin (`PUBLIC_URL`, else the loopback
request's own origin, else `resource_metadata` is omitted) and is shared by the hook and the MCP route. No credential →
`Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="fintrack:read fintrack:write"`;
`invalid_token` → `error` + `resource_metadata`; `insufficient_scope` → `error` + `scope` + `resource_metadata`.

**Protected Resource Metadata** (RFC 9728): `routes/wellKnown.ts` serves the same document at
`/.well-known/oauth-protected-resource/mcp` (path-inserted form for resource `<origin>/mcp`) and
`/.well-known/oauth-protected-resource` (the bare URL names the same `<origin>/mcp` resource; RFC 9728 §3.3 strictness applies to the path-inserted URL clients derive from the resource) — `{ resource, scopes_supported, bearer_methods_supported: ['header'], resource_name }`,
no `authorization_servers` until an authorization server exists. Both are public, mounted only when auth is `required`; with
neither `PUBLIC_URL` nor a loopback `Host` the answer is `404 resource_metadata_unavailable`.

**Access tokens.** `controllers/accessTokens.ts` — `createToken` (mints `AuthSecrets.randomAccessToken()` = `TOKEN_PREFIX` +
32 random bytes base64url; persists the sha256 and the display prefix; the plaintext is only in the flow's response),
`listTokens` (metadata + `status`, never a hash; both kinds), `revokeToken` (sets `revoked_at`, idempotent, `unknown_token` for an id that
is not the caller's — one revoke for both kinds), `revokeSignInByHash` (`fintrack logout` and a "this session only" shutdown hold the credential, not a
session; stdio kind only, idempotent), `authenticateToken(deps, hash, via)` (`logic/auth/token.ts`'s `evaluateToken` verdict; `last_used_at` rewritten at most every
`SESSION_TOUCH_INTERVAL_MS`; **one authenticate path for both kinds** — a `stdio` token is admitted only when `via` is `stdio`, `tokenAdmitsVia`, so a credential
lifted from the keychain is not also a key to `/api` and `/mcp`). Expiry choices are `TOKEN_EXPIRY_DAYS` (30/90/365 — no "never" for a new token; a legacy row with a null `expires_at` keeps authenticating and `tokenPages.ts` lists it as "No expiry (legacy)"). The pages are `routes/tokens.ts`
(`GET|POST /ui/access/tokens` — creation re-asks the login password (step-up) and shares the login attempt limiter — and `POST /ui/access/tokens/:id/revoke`; server-rendered by `tokenPages.ts`, same CSP/no-store headers as the
sign-in pages through `formPages.ts`) — **session-only**: browser HTML behind the cookie and the CSRF check, never reachable
with a bearer (the hook does not accept one on `/ui`, and each route also insists on `via: session`). There is no `/api` or MCP
way to manage tokens. The same page lists stdio sign-ins (`kind: stdio`: client as reported, profile, access, signed in, expires, last used) in a table of their own, with the same revoke. The shell's sidebar links to the page only when auth is `required` (the `AUTH_CONTROLS_MARKER`, next to logout).

**CSRF.** After authentication, an unsafe method authenticated by the session cookie (not a bearer) must declare (`Origin`, else `Referer`)
an origin in `allowedOrigins(PUBLIC_URL, Host)` — `PUBLIC_URL`, plus the request's own origin when its `Host` is
loopback; otherwise `403 forbidden_origin`. Public `POST`s are checked when the browser declares an origin. The hook
only reads the headers and translates; the decisions are pure functions in `logic/auth/` (`origin.ts`: `csrfVerdict`,
`preSessionCsrfVerdict`, `allowedOrigins`, `isLoopbackRequest`; `bearer.ts`: `credentialOf`, `bearerChallenge`; `scope.ts`: `hasScope`; `token.ts`: `evaluateToken`).

**Flows** (`controllers/auth.ts`, rules in `logic/auth/`, all through `runEffects`):
`issueSetupCode` (startup), `claimOwner` (`POST /ui/setup`), `claimOwnerLocally` and `resetPassword` (the CLI, below), `login`, `logout`, `authenticate` (every request;
writes nothing unless the session is stale, `SESSION_TOUCH_INTERVAL_MS`), `pruneExpiredSessions` (startup), `controllers/accessTokens.ts`'s `createToken`/`revokeToken`/`revokeSignInByHash`/`authenticateToken` (above), and
`controllers/grants.ts`'s stdio sign-in flows (next section).
Hashing, randomness and the clock are injected (`AuthDeps.secrets`, `clock`, `newId`); `diplomat/auth/credentials.ts`
supplies argon2id (OWASP first-choice parameters, named constants), the session/access-token/setup-code/user-code/device-code randomness and sha256. `adapters/auth.ts` adapts the
auth entities' batches once, in `composition/auth.ts`'s `bindAuthRunEffects` (five entities: user, session, setup code, access token, client grant); their appliers are plain
`versionedTableApplier`s registered at the composition root. The login/setup/logout pages and routes are
`diplomat/http/routes/auth.ts` (urlencoded body parsing lives only in that route scope, so `/api` keeps refusing it),
with in-process per-IP/per-username throttling (`diplomat/http/rateLimiter.ts`).

**CLI entrypoints.** `main.ts` hands any argument — `setup`, `auth`, `login`, `logout` (`wire/in/cli.ts`'s `CliCommand`), `help`/`--help`, or
anything else — to `diplomat/cli/commands.ts` (loaded lazily, with `composition/cli.ts`, the composition root that builds its `CliIo`), which returns a process exit code; an unknown command prints the usage and exits non-zero and **never
falls through to starting a server**. `login` and `logout` are described under *Stdio sign-in* below. `commands.ts` only routes; the handlers are `commands/{auth,login,setup}.ts`, and they reach the world through `CliIo` (`diplomat/cli/io.ts`) alone. `composition/cli.ts` opens the database like the server — the same `loadConfig`,
key resolution, `bootstrap` and migrations, so the owner row exists — over the engine context of
`diplomat/db/engine.ts`'s `createEngineContext` (shared with `composition/runtime.ts`) and `composition/auth.ts`'s `AUTH_APPLIERS` /
`createAuthDeps`; it starts neither HTTP nor stdio. Commands: `auth setup` and the first step of `setup [client]` run
`claimOwnerLocally` (the owner `update` of `claimOwner` — one shared `logic/auth/owner.ts` `claimedOwner` — with no setup code and no
session, and any outstanding code spent in the same batch; a claimed owner → `setup_unavailable`, reported as "already
claimed"); `auth reset-password` runs `resetPassword` (the user's hash `update`, a `remove` per session of that user, a
`revoked_at` `update` per live token of that user — one batch, other users' rows never read in). Trust model: reachable only
by someone who can open the database with its key. `commands/setup.ts`'s `runGuidedSetup(io, tool, claimOwner, signIn, profile)` claims first and writes the
client config only if the claim succeeded; with no terminal and no `--password-stdin` it fails before claiming the owner or writing the client config (the database has been opened and migrated by then).
`diplomat/cli/prompt.ts` asks the password twice with no echo (`node:readline`, a muted output stream), three tries; a TTY is
required unless the password is piped (`--password-stdin`, with `--username`) and stdin is never read when it is a terminal.
Results go to stdout, prompts and errors to stderr; nothing prints a password.

**Stdio sign-in.** A stdio process is spawned by whichever program the user pointed at it, so it acts as nobody until it
holds a credential — except under an explicit `FINTRACK_AUTH=disabled`, where it is the owner.

- *Credential, in this order* (`diplomat/mcp/stdioSession.ts`'s `createStdioSession`, built by `connectStdio` (`diplomat/mcp/stdio.ts`) from the `StdioAuth` `composition/stdio.ts` passes when `prepareAuth` returns
  a `stdio` capability — i.e. auth `required` and the transport is stdio, even with `FINTRACK_HTTP=false`): **`FINTRACK_TOKEN`** (a failure
  is an error state, never a fallback); a **keychain entry** (service `fintrack`, account `signin:<profile>:<dbId>` —
  `logic/auth/keychain.ts`'s `keychainAccount`, `dbId` = first 12 hex characters of sha256 of the absolute `DB_PATH`; `diplomat/auth/signInStore.ts`
  loads `@napi-rs/keyring` lazily and implements `controllers/deps.ts`'s `SignInStore`); else **none**. Every gated request
  re-validates the credential through `authenticateToken(…, via: stdio)`, so revocation and expiry take effect on the next call;
  a keychain entry that turns out invalid is deleted (only if it still holds that credential); a failed lookup is "could not check",
  never a sign-out.
- *Not signed in:* the first gated request starts ONE pending grant (reused until it is answered or runs out) and answers with the
  `STDIO_MESSAGES.notSignedIn` text — `FinTrack: not signed in. Open <origin>/ui/connect?code=ABCD-EFGH and confirm the code ABCD-EFGH.` (plus
  `ownerUnclaimedHint` while the owner is unclaimed; `notSignedInWithoutHttp` instead of the link when `FINTRACK_HTTP=false`). The URL carries the
  user code only; the device code, a token and every hash stay out of the URL and of every tool result. `<origin>` is `PUBLIC_URL`, else the sidecar this
  process bound (`logic/auth/origin.ts`'s `signInOrigin`, which names a non-loopback host only through `PUBLIC_URL`); when neither names a page, the session starts a **temporary
  server of its own** (the interpreter's `startPage` = `composition/signIn/server.ts`'s `startSignInServer`: a free `localhost` port, auth required, THIS database) on the first
  not-signed-in request and closes it once the request is redeemed, denied or expired, and at shutdown. It never names the configured `HOST:PORT` it did not bind: whatever
  listens there may have opened another database, and a grant written here would never validate there. With `FINTRACK_HTTP=false` there is no temporary server either. The
  session polls `redeemGrant` every `GRANT_POLL_INTERVAL_MS` on an unref'd timer and on each call; a redeemed sign-in is saved to the keychain unless its duration is
  `session`, which exists in memory alone and is revoked at shutdown (`session.close()`, best effort; the 12-hour cap covers a crash).
- *The protocol* (`logic/auth/signInFlow.ts`; its data in `models/auth/signInFlow.ts`; executed by `src/composition/signIn/interpreter.ts`): both
  edges — the stdio session and `fintrack login` — run ONE sign-in protocol, and every rule of it lives in `logic/auth/signInFlow.ts` and nowhere else:
  `nextStep(state, observation, config)` is pure and returns the new state and the effects, in order. The *state* is `idle`, `pending` (the request a person
  was asked to approve — the device code stays in memory), `signed_in` (the held credential, `ephemeral` when it lives in memory only, plus any request still
  open behind it) or one of the ends of a login (`denied`, `expired`, `cancelled`, `failed`). *Observations* are what an edge feeds (`requested`, `ticked`,
  `login_requested`, `logout_requested`, `interrupted`, `closed`, `errored`) and the answers to an effect (`credential_checked`, `saved_loaded`, `saved_cleared`,
  `owner_checked`, `page_named`, `page_served`, `grant_started`/`grant_failed`, `redeemed`, `saved`, `revoked`). *Effects* are data: the *asking* ones
  (`check_credential`, `load_saved`, `clear_saved_if`, `save_credential`, `revoke_credential`, `name_page`, `serve_page`, `start_grant`, `redeem_grant`,
  `check_owner`) are answered by exactly one observation and a step ends with at most one, last; the others are `close_page`, `wait` and `present` (what the edge
  tells the person: a `Presentation`, whose words the edge owns). The interpreter (`createSignInInterpreter`; `drive` feeds an observation and runs the effects
  until nothing is left, each answer fed straight back) is built at the composition root and injected as `controllers/deps.ts`'s `SignInInterpreter`; it executes and
  reports and chooses nothing. The rules, decided once: an env token never falls back; a saved credential found invalid is cleared only if the keychain still
  holds it; `session` never reaches the keychain; a refused save is revoked again (`login`) or held in memory and revoked at close (stdio); a denied or expired
  request ends a login and, for stdio, is retired so the next request asks afresh; an unexpected failure is "could not check", never a sign-out. The state
  diagram is in `docs/auth-flows.md`.
- *The grant* (`controllers/grants.ts`; rules in `logic/auth/grant.ts`): `startGrant` (device code returned once, only its sha256 stored; user code drawn
  until no pending grant holds it), `approveGrant`/`denyGrant` (browser **session only**; the grant must be pending and unexpired; the approval binds the approving user, the chosen
  scopes and duration, and `approved_at`; `session` is refused for a `cli` grant), `redeemGrant` (single use: it mints the `kind: stdio` token — expiry
  `signInExpiry(approved_at, duration)`, absolute and capped at `MAX_SIGN_IN_DURATION_MS` — and marks the grant `redeemed` in the same batch, so a replay is refused by the version guard; `pending`/`denied`/`expired`/`invalid` are the other answers, the
  terminal ones final), `findConsent` (the consent page's data and pre-selection: the asker's hint, else this user's `lastRedeemed` choice for this client and profile, else read-only/24 h),
  `pruneExpiredGrants` (startup: unredeemed grants past their window are deleted, and so are redeemed ones superseded by a newer approval — `logic/auth/grant.ts`'s `supersededGrants` keeps the newest per user, profile and client, the pre-selection's memory; a live pending or approved grant is never touched). The grant is a database row, so
  it works across processes.
- *The page* (`diplomat/http/routes/connect.ts`, `connectPages.ts`, `ui/connect.html`): `GET|POST /ui/connect`, behind the session and the CSRF check
  (never public, never a bearer), the same headers and escaping as the other form pages, failed lookups throttled per IP
  (`MAX_CODE_LOOKUP_FAILURES_PER_IP`). It shows the client name/version "as reported by the client" (cleaned by `wire/in/auth.ts`'s `clientInfoOf`), the profile, the request time, the code and the
  warning; the radios come from the enums. An unknown, expired or answered code is the same neutral `invalid_grant` page.
- *Terminal:* `diplomat/cli/commands/login.ts` — `fintrack login [--profile] [--duration] [--scope]` runs the same protocol over the `cli` channel (flags only pre-select the page): it feeds `login_requested`, then `ticked` (or `interrupted` after Ctrl-C) while a request is open, prints what the protocol presents, and the result is kept
  in the keychain profile (revoked again if the keychain refuses); `fintrack logout [--profile]` revokes the saved sign-in (`revokeSignInByHash`) and deletes the entry, idempotently;
  `setup`'s last step offers the same flow for the client's profile. `src/composition/signIn/server.ts` starts the temporary loopback app (`buildHttpApp`, auth required, a free port of `localhost` — loopback only, and a host name of its own so its session cookie, keyed by host, never replaces another FinTrack's at `127.0.0.1`) that serves `/ui/connect` for the duration of the login — never a server already on `HOST:PORT`, which a healthy `/api/health` does not prove opened this database. The shared repos/appliers/runner assembly is `src/composition/runtime.ts`'s `createRuntime` (also what `composition/boot.ts` uses).

**Startup order** (`composition/boot.ts`, and every command that opens the database): `openDatabase` → `bootstrap` = **version guard** (`diplomat/db/versionGuard.ts`'s `checkDatabaseNotAhead`:
the database's newest applied migration, `migrationJournal.ts`'s `lastAppliedMillis`, against the newest this build's journal ships — `logic/migration.ts`'s `isDatabaseAhead`; a database that is ahead makes `bootstrap` return an error `DatabaseAhead` (`models/database.ts`), which `main.ts` and the CLI print with `databaseAheadMessage` and exit 1; nothing has been written) → safety copy (if a data-rewriting migration is pending) → migrate → seed → `prepareAuth` (identity deps; prune expired sessions and grants) → connect stdio → sidecar → announce the setup code.

**Sessions.** Opaque 32-byte base64url token; `sha256(token)` stored. Sliding idle expiry
(`SESSION_IDLE_TTL_MS`) capped by `SESSION_ABSOLUTE_MAX_MS` from creation; `last_seen_at`/`expires_at` rewritten at most
every `SESSION_TOUCH_INTERVAL_MS`; logout deletes the row; expired rows are deleted when presented, at login and at
startup. Cookie: `HttpOnly; SameSite=Lax; Path=/; Max-Age`, `Secure` iff `PUBLIC_URL` is `https`.

**Public surface and health.** `GET /api/health` returns `{ status: 'ok', db: 'ok' | 'error' }` through
`controllers/status.ts`'s `getHealth`, which shares `databaseState` with `getStatus` (one DB check). `/api/status`
requires a session. The container `HEALTHCHECK` is `/api/health`.

## Tool surface

55 MCP tools (contract: `docs/mcp-tools.md`), most mirrored as REST routes, both thin over the same controllers — `list_budgets`/`get_budget_status` (Feature Design 015) now have REST parity (`GET /api/budgets`, `GET /api/budgets/status`); `create_budget`/`update_budget`/`delete_budget` and `find_correlations` (Feature Design 016) are MCP-only for now, no REST mirror yet. `set/list_exchange_rates` and `set_base_currency` (ADR-026 Phase 2) have full REST parity (`GET`/`POST /api/exchange-rates`, `POST /api/exchange-rates/bulk`, `GET /api/preferences`, `POST /api/settings/base-currency`). Client connections: `docs/mcp-clients.md`.

**Scopes:** every tool declares `annotations.readOnlyHint` and needs `fintrack:read` (read-only) or `fintrack:write` (`docs/mcp-tools.md` § Scopes per tool). Over HTTP the scopes are the request's principal's; over stdio they are the signed-in credential's (a read-only stdio sign-in is refused a write tool with `insufficient_scope`), and an explicit `FINTRACK_AUTH=disabled` run is the owner with every scope. Resources and prompts need `fintrack:read`.

**Transport:** controlled by `MCP_TRANSPORT` (zod enum, `config.ts`). Default is **`stdio`** — the client spawns the process; no port, no Fastify. Set `MCP_TRANSPORT=http` to start the Fastify server (REST + streamable HTTP MCP on `PORT`). Both transports connect the same `buildMcpServer(deps, version)` core; no domain code moves. (ADR-007)

## Diplomat edge organization (ADR-025)

Both diplomat edges are organized as per-domain registration/route modules mirroring `controllers/`, rather than
one large file each. **The convention:** a new MCP tool/resource/prompt or HTTP route lives in the domain module
matching its controller; the entrypoint (`server.ts`/`routes.ts`) never inlines a new registration.

**MCP — `diplomat/mcp`.** `tools/<domain>.ts` (`account`, `creditCard`, `transaction`, `transfer`, `budget`,
`recurring`, `category`, `tag`, `dashboard`, `correlations`, `aggregate`, `summary`, `currencyRates`, `system`) each export a
`register<Domain>Tools(server, ctx)` that registers exactly the tools whose controller lives in that domain —
`aggregate`/`summary` get their own thin module for the same reason `correlations` does: a single-tool domain is
still a domain, mirroring its single-file controller (`controllers/aggregate.ts`/`summary.ts`). `resources.ts`
(`registerResources`) and `prompts.ts` (`registerPrompts`) stay single cross-domain modules — few enough, and
cross-cutting enough, not to warrant per-domain splitting. `respond.ts` holds the shared response helpers
(`json`, `jsonError`, `fromResult`, `jsonResource`); `annotations.ts` (`READ_ONLY`/`MUTATING`), `scopes.ts` (`guardScopes`, `toolScopesOf`), `gate.ts` (the `PrincipalGate` each transport supplies) and `authInfo.ts` carry the per-tool scope; `stdioSession.ts` is the stdio channel's identity (a presenter over the injected sign-in interpreter); `context.ts` defines `McpContext` (`{ version, as(extra) }` — `as` returns the caller's scoped `{ deps, runEffects, runEffectsSequence, resetLocale }`, built from the principal the scope guard put on the callback's `extra`), built once in `server.ts` and passed to every register call so
no module carries the full parameter list. `server.ts` reduces to construction + aggregation: build the server,
build `ctx`, call each `register…` once.

**HTTP — `diplomat/http`.** `hooks/<concern>.ts` holds cross-cutting request interceptors (`hooks/auth.ts`), registered
by `composition/http.ts` before any route; `routes/<domain>.ts` (`account`, `category`, `creditCard` — including `Bills`
alongside credit cards, same as the MCP side — `transfer`, `recurring`, `transaction`, `tag`, `currency`,
`currencyRates`, `settings`, `dashboard`, `aggregate`, `summary`, `system`) each export a `<domain>Routes(): RouteDefinition[]` (only `system` takes the context — its health probe uses `publicDeps`); a handler is `(req, reply, scope)` and asks `scope()` for the caller's scoped dependencies — exactly the routes
whose controller lives in that domain. Each module declares its own `<DOMAIN>_TAG` constant(s) for its OpenAPI
tag(s) (`creditCard.ts` alone has two: `CreditCards` and `Bills`) rather than pulling from a shared enumeration,
since no tag is used by more than one domain file. `respond.ts` holds the shared response helpers (`send`,
`parse`) and OpenAPI response/param shorthands (`validation422`, `notFound404`, `conflict409`, `nameParam`,
`idParam`, `confirmQuery`, `CACHE_CONTROL_NO_CACHE`); `context.ts` defines `HttpContext` (`{ deps, version,
runEffects, runEffectsSequence }`), built once in `routes.ts` and passed to every route builder. `GET /ui`,
`GET /ui/:name`, and `GET /ui/assets/{app.css,app.js,money.js}` — browser-facing HTML/asset routes, not
`RouteDefinition`s (no OpenAPI entry) — are mounted by `routes/ui.ts`'s `registerUiRoutes(app)`, called from
`registerRoutes` alongside `mountRoutes` (ADR-027 Phase 1; see § Dashboards / `/ui` surface). `routes/auth.ts`'s `registerAuthRoutes` (the `/ui/login`, `/ui/setup`, `/ui/logout` pages — browser HTML like `routes/ui.ts`,
no OpenAPI entry; mounted only when auth is `required`) is called from `registerRoutes` too, as are `routes/tokens.ts`'s `registerTokenRoutes` (`/ui/access/tokens` pages, session-only) and `routes/wellKnown.ts`'s `registerProtectedResourceMetadataRoutes` (both likewise only when auth is `required`). `routes.ts`
reduces to construction + aggregation: `buildRouteDefinitions` concatenates every domain's array into the one
list `mountRoutes`/`buildOpenApiDocument` consume (§ OpenAPI contract), and `registerRoutes` mounts it, the UI
shell/asset routes, and `/api/openapi.json`.

## HTTP sidecar (ADR-013 Decision 7)

In the default **stdio** transport, the HTTP server (REST + streamable HTTP MCP, `diplomat/http`/`diplomat/mcp`) runs alongside it as a **best-effort sidecar**, so `/api` and `/ui` are reachable by default — the dashboard experience is a core feature, not an add-on the user has to discover and opt into. Composed in `src/composition/http.ts` (`buildHttpApp`, `startHttpSidecar`) and started from `composition/stdio.ts` (and, for pure HTTP, `composition/http.ts`'s `runHttp`), the composition roots — kept out of `diplomat/http`/`diplomat/mcp` so neither edge depends on the other.

- **On by default, opt-out via env:** `FINTRACK_HTTP` defaults to `true` (with `PORT`, default `51737` — see below), so the sidecar starts without any env var set. `FINTRACK_HTTP=false` is the only value that disables it (stdio-only, zero ports bound); any other value leaves it on.
- **Non-fatal bind failure is a fallback, not the normal state:** if the port can't be bound (most commonly `EADDRINUSE`), `startHttpSidecar` catches the error, logs an actionable message, and returns `{ listening: false }` instead of throwing. The stdio MCP connection — established before the sidecar is attempted — is unaffected either way; only `/api`/`/ui` stay unavailable for that run, and the user can diagnose the conflict from chat since stdio is still up.
- **stderr only, never stdout:** stdio carries the MCP protocol on stdout (ADR-007), so the sidecar's Fastify instance runs with `logger: false` and all sidecar messages (startup banner — including the `/ui/overview` URL so the user knows where to open the dashboard — and the bind-failure diagnostic) go through `console.error`.
- **Clean shutdown:** SIGINT/SIGTERM and stdin end/close (client disconnect) drain both the stdio server and the sidecar (only if it's actually listening) before the process exits.
- **Pure `http` mode is unchanged:** when `MCP_TRANSPORT=http`, the Fastify server (`buildHttpApp`, default `logger: true`) is the *only* surface running, so a bind failure there stays fatal (`process.exit(1)` with an actionable message) — there is no stdio fallback to keep the process alive. This is a deliberate, documented difference from the sidecar's non-fatal handling, not a regression.
- **Loopback bind by default, configurable via `HOST` (`config.ts`; default `common/net.ts`'s `LOOPBACK_HOST`, `127.0.0.1`):** both the sidecar (`startHttpSidecar`'s `host` argument) and pure `http` mode bind `config.HOST` — the `::`/`0.0.0.0` wildcard is an explicit opt-in (a container must bind it; its port publish must stay on the host's loopback). Startup banners and the port-in-use hint print `httpOrigin(host, port)` (`common/net.ts`): a wildcard host prints `127.0.0.1`, any other host prints itself. A wildcard or LAN bind is reachable from any device on the network, not just this machine — verified empirically, not just in theory — `FINTRACK_AUTH` is `required` by default everywhere (§ Authentication), and `FINTRACK_AUTH=disabled` on a non-loopback `HOST` is a startup error. Auth is resolved once in `composition/auth.ts`'s `prepareAuth` (between `bootstrap` and the first listener): when nothing serves HTTP, or auth is disabled, it builds nothing and issues no setup code. Otherwise it builds the identity deps and prunes sessions, and returns `issueAndAnnounceSetup(boundOrigin)`, which `composition/stdio.ts`/`http.ts` call only once a server has bound: the code is issued (replacing the previous one in place) and printed then, so the banner's URL is the real one (`PORT=0`) and a process whose sidecar failed to bind — another stdio server owns the port and has announced its own code — neither prints nor replaces anything. `localhost` may still fail to connect on systems where it resolves to IPv6 `::1`; clients should use `127.0.0.1` explicitly (`docs/mcp-clients.md`).
- **Default `PORT` differs by run mode, deliberately:** the published package (`config.ts`'s `DEFAULT_PORT`) defaults to `51737`, chosen because it sits in IANA's dynamic/private range (49152-65535) — never assigned to a registered service — rather than a common Node/Fastify/React dev-server port like 3000/3001/8080, which would maximize collision risk with other software on a typical machine. `npm run dev` overrides `PORT` back to the familiar `3001` (`package.json`), so a contributor's local dev instance never collides with an already-running installed instance on the published default. The two values are independent knobs, not a `NODE_ENV`-style branch in `config.ts` — only the npm script differs.

## Distribution: container image

Besides the npm package, the repo ships an image (`Dockerfile`, `compose.yaml`; published to `ghcr.io/rafaelfcarneiro/fintrack`, multi-arch, tagged like the npm version plus `latest`). Image defaults: `MCP_TRANSPORT=http`, `HOST=0.0.0.0`, `PORT=51737`, `DB_PATH=/data/fintrack.db`, `NODE_ENV=production`; runs as the non-root `node` user behind `tini`; `/data` (a volume) is the only writable path, the root filesystem is mountable read-only (`compose.yaml` does) with `/tmp` as tmpfs. The encryption key is never in the image or the volume: it arrives as a file (`FINTRACK_DB_KEY_FILE`, a Docker secret), and startup fails fast without a key source. CI and release build `FROM` a GHCR mirror of the Docker Hub base image (falling back to Docker Hub when it is unavailable — `docs/releasing.md` § Base-image mirror), because Docker Hub rate-limits anonymous pulls from shared runners. The healthcheck is `GET /api/health` (public; `db: ok` is required). `HOST=0.0.0.0` makes auth `required`: the first start prints a one-time setup code to the container log, and `/ui/setup` claims the owner (§ Authentication). Exactly one container per volume (SQLite, in-process change bus and scheduler). Every shipped example still publishes the port on host loopback only (`127.0.0.1:51737:51737`): the container speaks plain HTTP. MCP clients and scripts authenticate `/mcp` and `/api` with a personal access token (`Authorization: Bearer ftk_…`, § Authentication). `src/` is identical for npm and container runs; the build/publish pipeline is in `docs/releasing.md`.

## OpenAPI contract (ADR-013 Phase A)

Every REST route is declared exactly once, in its domain module under `diplomat/http/routes/` (§ Diplomat edge organization), and concatenated by `diplomat/http/routes.ts`'s `buildRouteDefinitions(deps, version)` into a single array where each entry carries its method, path, `wire/in`/`wire/out`/`models`-derived request/response schemas, **and** its real handler together. There is no second, hand-maintained list to fall out of sync: `mountRoutes` (`diplomat/http/openapi.ts`) mounts the array on Fastify, and `buildOpenApiDocument` documents the same array via `@asteasolutions/zod-to-openapi`'s `OpenApiGeneratorV3` — neither function depends on the other, so a route that's mounted is, by construction, the same route that's documented. (An earlier version of this kept the route list and the OpenAPI registry as two separate, manually-synced files; that duplication was the actual defect, not something a parity test should merely detect after the fact — so the design was collapsed to one array instead. A unit test (`test/unit/diplomat/http/openapi.test.ts`) still checks the two consumers agree, mainly to guard against a future route being mounted by hand outside the array.)

The same document is exposed as the MCP resource `fintrack://openapi` (`diplomat/mcp/resources.ts`), so a tools/resource-only agent — including under the **stdio** transport, which never starts Fastify — can read the contract without an HTTP round-trip. This is the first MCP resource in the app (as opposed to tools). It calls `buildOpenApiDocument(buildRouteDefinitions(deps, version), version)` directly: building the array only constructs handler closures (never invokes them), so it needs no live Fastify instance. `diplomat/mcp` importing `buildRouteDefinitions`/`buildOpenApiDocument` from `diplomat/http` is a narrow, documented exception to the dependency table (§ Dependency direction) — both are deterministic, no-business-logic builders, the same category of shared artifact both diplomats already import (wire schemas, models).

`diplomat/http/openapi.ts` holds only routing/doc-generation mechanics (`RouteDefinition`, `mountRoutes`, `buildOpenApiDocument`) — no wire schemas. Response shapes with no dedicated `wire/out` schema before this change (e.g. `BillView`, `ApplyDueResult`, the credit-card delete dry-run union, the shared `{ error }` envelopes for 404/409/422) got new small `wire/out` schemas (`wire/out/{bills,recurring,creditCards,common,errors}.ts`), same as any other response shape; request-side generic path-param/query shapes (`name`, `id`, `confirm`) got `wire/in/common.ts`. Unlike request schemas, these response schemas are not zod-validated at runtime (routes never parse their own outbound payloads), so they are best-effort documentation, not an enforced contract.

## Reference resources (Feature Design 018)

`fintrack://categories`/`accounts`/`tags`/`credit-cards` (`diplomat/mcp/resources.ts`) are read-only, static-URI MCP resources that reuse the matching `list_*` read controller verbatim and serialize its result — the resource and its tool can never disagree, same principle as `fintrack://openapi` reusing `buildOpenApiDocument`. `fintrack://merchants/top` is the one addition with a new read path: `MerchantsRepo.top(limit)` (`diplomat/db/repos/merchants.ts`) groups effective, non-transfer transactions by `merchant_key`, resolves each merchant's dominant category (by transaction frequency, ties broken alphabetically), orders by count descending, and caps at `DEFAULT_TOP_MERCHANTS_LIMIT` (`models/merchant.ts`, 20) — a `controllers/merchants.ts#topMerchants` locale-resolves the category name before the resource serializes it. No `ResourceTemplate`/caller-supplied limit — it's a vocabulary list, not a tunable report. `fintrack://currencies` (ADR-026 Phase 1) mirrors `GET /api/currencies` — both call `controllers/currencies.ts#listCurrencies` (`CurrenciesRepo.list()`, `diplomat/db/repos/currencies.ts`) — rather than a `list_*` tool, since there is no MCP write-side counterpart for currencies (a seeded reference table, never user-mutated): `{code, symbol, name, decimals}` per currency, the metadata a client needs to format a code `Intl.NumberFormat`'s currency mode can't handle correctly — `USDC` throws (4 letters fail its syntax check) but `BTC` doesn't (3 letters pass, then it's silently mis-formatted with fiat-shaped precision and no real symbol) — so detection must be explicit (`Intl.supportedValuesOf('currency')`), not try/catch; see `ui/money.js` (`docs/ui.md`). `fintrack://exchange-rates` (ADR-026 Phase 2) mirrors `GET /api/exchange-rates`/`list_exchange_rates` — the raw cached `currency_rates` table, each entry with its own `asOf`; staleness is not evaluated at this resource, only by `logic/currencyRate.ts`'s `convert` when a consumer reads it (`get_account_balances`, ADR-026 Phase 3).

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
- ADR-023: an applier decides nothing and performs no reads — merchant/tag/learning decisions move into the core; idempotency is the engine's, opted into per-insert by the envelope's own key presence against a fixed dedup column (extends ADR-021/022; column convention fixed by ADR-029 Phase 2b)
- ADR-024: local SQLite concurrency posture — WAL + `busy_timeout` + `SQLITE_BUSY` retryable in `runEffects`; multi-client use steered to the HTTP transport (ADR-007)
- ADR-025: diplomat edge organization — MCP tools/resources/prompts and HTTP routes in per-domain modules mirroring `controllers/`; entrypoints only aggregate
- ADR-026: multi-currency valuation — crypto (USDC, BTC) first-class, agent-refreshed `currency_rates` table, `user_settings.base_currency` (per user since ADR-033 Phase 4), read-time conversion on `get_account_balances`; relaxes no-implicit-conversion for **valuation** only (**accepted, complete**; Phase 1 — crypto currencies — complete, Phase 2 — `currency_rates`/`base_currency`/the pure conversion helper — complete, Phase 3 — `get_account_balances` valuation, controller-orchestrated per ADR-028 — complete). Follow-on Feature Design 021 (opt-in `displayCurrency` grand totals on the other per-currency reads) — Phase 1 (`get_spending_summary`), Phase 2 (`get_budget_status`), and Phase 3 (`find_correlations`) all complete.
- ADR-027: UI app shell — shared shell hosting dashboard **content fragments**; `source: inline|file` discriminator (defaults are git-versioned files, customs stay inline, `save_dashboard` always inline); entity-tagged **SSE** live-update (the change bus itself is `@rfc0/effect-runner`'s `createChangeBus`; FinTrack owns only the SSE forwarding + composition-root wiring); same Fastify, no build (extends/revises ADR-013; see `docs/ui.md`)
- ADR-028: read-side cross-aggregate correlation lives in controllers, not repos — refines ADR-011 (aggregation stays in the repo; correlating two aggregates does not); transaction "what counts" predicates single-sourced (`txPredicates`); applied to `get_budget_status` (phase 2) and `find_correlations`' `budget_fit` (phase 3, complete) — `budgetTargetMatch` fully retired
- ADR-029: managed-entity persistence contract — an engine-owned base for id/version/idempotency, and the seam for a future DB-agnostic effect engine; refines ADR-021/022/023, realizes #134 (accepted; Phase 1 — `PersistenceMeta`/`withPersistenceMeta`, one declaration home for the version token — complete; Phase 2 — idempotency key onto the `insert` envelope, dropped from `TransactionSchema` — complete; Phase 2b — domain-owned hashed key over the full deterministic identity (funding source included), caller supplies only an optional `discriminator`, fixed `idempotencyKey` dedup column by convention — complete)
- ADR-030: extract the effect engine into a DB-agnostic core behind an explicit adapter port — delivers ADR-029 Phase 3 at the agreed 3a scope, SQLite stays the sole adapter (Postgres/3b is its own future ADR); refines/extends ADR-021/022/023 (accepted; Phase 1 — the port seam in place, still inside `diplomat/db`: `TransactionRunner`/`isTransientContention` injected in place of a direct `Db`/`isSqliteBusy` dependency, `runEffects`/`runEffectsSequence`/`EntityApplier`/`ApplierRegistry`/`ReadBack` generic over an opaque `Tx`, behavior-preserving — complete; Phase 2 — relocated the driver-free core and the `Persistable`/`PersistenceMeta` data contract to `src/effects/`, decoupled the engine from FinTrack's error taxonomy (generic over an injected `conflictError` factory), `diplomat/db` is now the SQLite adapter (`versionedTableApplier`), lint-enforced dependency isolation — complete; Phase 3 (repo/package lift-out) — delivered by ADR-031; 3b (Postgres adapter) — deferred, own ADR)
- ADR-031: the effect engine lives in its own repository and is consumed as the published `@rfc0/effect-runner` package (MIT, npmjs.com, semver-governed port) — FinTrack keeps only the SQLite adapter (`diplomat/db`) (accepted; complete)
- ADR-032: Docker distribution — container image on GHCR, HTTP transport by default, SQLite on a volume; `HOST`, `FINTRACK_DB_KEY_FILE`, fail-fast key resolution and lazy keychain import (accepted; Phase 1 — container-ready runtime — complete, Phase 2 — image/CI/publish — complete)
- ADR-033: authentication and multi-user — identity (owner row by migration, password login, sessions, setup code), personal access tokens, in-process OAuth 2.1 AS for MCP, per-user tenancy; phased (accepted; Phase 1 — identity: owner row, sessions, setup code, UI login, auth mode, minimal public surface — complete; Phase 2 — personal access tokens, scopes, challenges, Protected Resource Metadata — complete; Phases 3–4 pending)
- ADR-034: authentication on by default (`FINTRACK_AUTH=required` everywhere), terminal owner claim inside `setup`, and browser sign-in for stdio sessions with chosen expiry; revises ADR-033 §1 (accepted; step 1 — auth by default, `setup`/`auth setup`/`auth reset-password`, PAT expiry without "never" — and step 2 — stdio sign-in, `login`/`logout`, `/ui/connect`, the startup version guard — are implemented)
