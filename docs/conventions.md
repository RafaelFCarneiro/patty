# Conventions — how this repository applies the canonical docs

The four documents in `docs/canonical/` (`diplomatic-architecture.md`, `functional-core-imperative-shell.md`,
`code-quality.md`, `code-style.md`) are agnostic: principles with neutral examples, naming no file, library or
decision of this repository. **This document is where they meet the code** — the libraries chosen, where the
shared helpers live, what lint enforces and where, the folder and test layout, and the do/don't examples written
against real files and entities. `docs/architecture.md` describes the system as built; `docs/write-path.md` the
write-path mechanics; `docs/adr/` the decisions. Generated code MUST match the patterns here.

## Libraries and shared helpers

| Concern | Choice | Where |
|---|---|---|
| Schemas and boundary decoding | zod (single source of truth for domain types) | `models/`, `wire/` |
| Fallible control flow | neverthrow `safeTry` / `ResultAsync` (Railway-Oriented) | controllers |
| Data reshaping | remeda (`R.pipe`, `groupBy`, `countBy`, `firstBy`, …) and its `purry` for dual-calling helpers | `logic/`, `adapters/` |
| `guard` / `okOr` combinators | `common/result.ts` | |
| Name resolution (`resolveAccountRef`, `resolveCategoryRef`, `resolveCardRef`) | `controllers/resolve.ts` | |
| Controller dependencies (`Deps`, read-only ports) | `controllers/deps.ts` | |
| `Persistable` builders (`insert`/`update`/`remove`, `PersistOp`) | `logic/persistence.ts` | |
| Effect engine (`runEffects`, `Persistable`, `INITIAL_VERSION`, `VersionConflict`, change bus) | external package `@rfc0/effect-runner`; SQLite port in `diplomat/db` | |
| Domain error payloads | colocated on each entity model (`accountErrors`), shared primitives in `models/error.ts` | |

## Lint enforcement (`eslint.config.js`)

- Imperative constructs — `for`/`for…of`/`for…in`/`while`/`do…while`, `let`, `.push(` — are errors in
  `src/logic/`, `src/controllers/` and `src/adapters/`. The shell (`diplomat/**`) and the composition root
  (`composition/**`) are exempt.
- Repo-wide (`src/**`, `test/**`): `@typescript-eslint/consistent-type-imports` (a type is imported as a type:
  `import { a, type B } from 'm'`) and `no-duplicate-imports` (one import per module).
- Function shape on all of `src/**`: 40 lines (blank lines and comments excluded), cyclomatic complexity 10, nesting
  depth 3, 15 statements; a `switch` of 7 or more labels is an error (`SwitchStatement > SwitchCase:nth-child(7)`).
- File and folder names under `src/`, `test/`, `ui/` and `scripts/` are kebab-case (`eslint-plugin-check-file`).
- `ToolName` (`diplomat/mcp/tool-name.ts`) is lint-restricted to the MCP edge.

## Layout and tests

- Layers live under `src/`: `adapters/`, `controllers/`, `diplomat/`, `logic/`, `models/`, `wire/{in,out,db}`,
  `composition/`, `main.ts`, `config.ts` (the `diplomat/` submodules include `http/`, `mcp/`, `db/`).
- A domain with more than one file in a layer gets a folder in that layer, and its files drop the folder's name
  (`logic/demo/plan.ts`, `logic/demo/database.ts`, not `logic/demo.ts`, `logic/demo-database.ts`; the same for
  `controllers/auth/` and `models/demo/`).
- Tests live under `test/unit/` and `test/integration/` in a mirrored path, never colocated: the vitest configs
  only scan those folders, so a colocated `src/**/*.test.ts` silently never runs. Every logic function gets a mirrored
  `test/unit/logic/*.test.ts` (pure, no mocks).
- `diplomat/http` and `diplomat/mcp` follow the same rule: decode with `wire/in`, adapt to models, call controllers,
  then adapt model results to `wire/out`.
- Imports are ESM with NodeNext: relative imports end in `.js` (`from './driver.js'`). Dates are `YYYY-MM-DD`
  strings end-to-end, month math in pure logic (`period.ts`, `recurring.ts`). IDs come from `deps.newId()`;
  seeds use stable slugs (`cat-transporte`). User-facing strings may be Portuguese; identifiers and comments are English.
- Decisions behind these rules: ADR-001/003 (functional style), ADR-019 (compose up), ADR-021 (write path), ADR-025
  (edge organization) — see `docs/adr/`.

## Code style (applied)

Rules with examples — follow these when writing ANY code in this repo. The do/don't pairs below
come from real refactors; generating in the "don't" style means the code will be rewritten.

### General

- TypeScript strict, ESM with NodeNext: **relative imports end in `.js`** (`from './driver.js'`).
- `const` + expressions over `let` + mutation. Arrow functions. No classes anywhere in the domain
  (the only acceptable class usage is library-provided, e.g. the MCP SDK server).
- Prefer small named functions over inline complexity; extract when a function does two things.
- Comments explain *why* (invariants, trade-offs), never *what* the code already says. A rule the code cannot show (a guarantee a port makes, a race a write closes, a column a revert must clear) is pinned by a test with a descriptive name, not only by a comment — a comment can rot, a failing test cannot.

### Controllers — safeTry composition (Railway-Oriented)

Controllers return `ResultAsync<T, AppError>` and compose with `safeTry` generators.
Each `yield*` short-circuits on the error track. NEVER write resolve-then-early-return chains.

```ts
// ✅ DO
export const payBill = (deps: Deps, input: PayBillInput): ResultAsync<Bill, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card)
    const bill = yield* okOr(await deps.bills.get(card.id, input.month, input.year), {
      code: 'unknown_bill', card: card.name, month: input.month, year: input.year,
    })
    return ok(await deps.bills.setStatus(bill.bill.id, 'paid'))
  })

// ❌ DON'T
export const payBill = async (deps, input) => {
  let cardId: string | null = null            // let + mutation
  const res = resolveByName(...)              // duplicated resolution boilerplate
  if (res.kind === 'none') return err(...)    // early-return chains
  ...
}
```

- Preconditions: `yield* guard(cond, error)`. Nullables: `yield* okOr(value, error)` (`common/result.ts`).
  Both arguments are named, not inline: the **condition** is a predicate (pure → `logic/`; repo-touching →
  a small async controller helper) and the **error** is a colocated model payload. Don't bury the rule in
  an inline boolean or hand-roll the `{ code, … }` literal:

  ```ts
  // ✅ DO — condition + payload each have a home
  yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected)        // pure predicate (logic/)
  yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name)) // repo predicate (controller)

  // ❌ DON'T — inline condition + inline error literal
  yield* guard(input.type !== AccountType.enum.credit, { code: 'validation', issues: ['…'] })
  yield* guard(!(await deps.accounts.findByName(input.name)), { code: 'duplicate_name', entity: 'account', name: input.name })
  ```
- Controllers work with **models only**: hand repos domain drafts (e.g. `TransactionDraft`); never build
  flat db props (`classificationMethod`, `rawInput: null`) and never import `adapters/` — model→db
  flattening lives in `diplomat/db` via `adapters/`.
- All boundary adaptation lives outside controllers: diplomats adapt `wire/in -> model` before controller
  calls and `model -> wire/out` after controller results. Repos may use adapters internally for
  `model <-> wire/db`.
- Name resolution: ALWAYS via `controllers/resolve.ts` (`resolveAccountRef`, `resolveCategoryRef`,
  `resolveCardRef`) — never inline `resolveByName` + error mapping in a controller.
- Expected failures are `AppError` values; unexpected errors throw (become 500s). Never `try/catch`
  business outcomes; never throw domain errors.
- When resolving independent async deps, pipe `Promise.all` through `R.pipe` for an expression body:

```ts
// ✅ DO
export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> =>
  R.pipe(
    await Promise.all([deps.health.reachable(), deps.locale().catch(R.constant(Locale.enum.en))]),
    ([reachable, locale]) => ({ name: 'fintrack', version, db: reachable ? 'ok' : 'error' as const, locale }),
  )

// ❌ DON'T
export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> => {
  const [reachable, locale] = await Promise.all([...])
  return { name: 'fintrack', version, db: reachable ? 'ok' : 'error', locale }
}
```

#### Write-path controllers — return effects, don't perform them (ADR-021)

**In progress — not every controller is converted yet.** `docs/canonical/functional-core-imperative-shell.md` is the
canonical doc; read it before touching a write flow. The shape below is the target for the whole write path,
proven so far on `createAccount` (`controllers/account/account.ts`) as the first mover. An unconverted flow
still calls its `deps.<x>.create/update/...` write method exactly as documented above — don't convert a flow
that isn't in scope for your change just because you're touching the file.

A converted controller still composes with `safeTry`/`guard`/`okOr` exactly as before — only the last step
changes: instead of `await`ing a repo write and returning the written row, it builds the write as a typed
`Persistable` (`@rfc0/effect-runner`) via the `logic/persistence.ts` builders, and returns it alongside the
response, for the diplomat shell's `runEffects` (`@rfc0/effect-runner`) to apply:

```ts
// ✅ DO — the core decides and returns the write as data; it never calls a repo write method
export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected)
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name))

    const account: Account = { id: deps.newId(), ...input }  // no version — a new row's is the shell's constant
    const persist: Persistable[] = [persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: account })]
    return ok({ persist, response: account })
  })

// the diplomat handler (MCP tool / REST route) adapts model → row explicitly, right here, before
// runEffects ever sees the batch — this is the shell applying the effect
async (args) => {
  const flow = () => createAccount(deps, accountAdapters.createWireInToModel(args)).map(accountAdapters.outcomeToDb)
  return fromResult(await runEffects(flow))
}

// ❌ DON'T — the core performing its own write (the pre-ADR-021 shape; fine for an unconverted flow, but
// don't reintroduce it on a flow you're converting)
export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<Account, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected)
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name))
    return ok(await deps.accounts.create({ id: deps.newId(), ...input }))
  })
```

- Build the `Persistable` via `logic/persistence.ts`'s `insert`/`update`/`remove` — one place every converted
  controller constructs the tagged shape from, instead of hand-writing an `{ op, entity, model }` literal at
  each call site. These builders are generic over the entity's tag/model (not hardcoded to any one entity), so
  they never need a new case as more flows convert. The write intent (`op`) they set is a named enum
  (`PersistOp`), not a bare `'insert'`/`'update'`/`'delete'` string — "constants over literals" applies to the
  op the same as any other domain value.
- **The entity tag is owned by the entity's own model file**, not by `@rfc0/effect-runner` (`Persistable` is
  generic): `models/account.ts` owns `ACCOUNT_ENTITY_TAG = 'account'`, and a new entity adds its own constant
  there — a shared god enum would be magic-value coupling.
- An `insert` `Persistable`'s model is the plain, wire-shaped domain model (`Account`) — **no `version`**. A
  brand-new row's version is always the same structural constant (`INITIAL_VERSION`, exported from
  the package); that's not a decision the core makes, so it never appears in what the core builds
  or returns. `update`/`delete` are different: `version` is the value the core actually read, so it's real
  data the model carries (`AccountEntity` — `Account` + `version`).
- **The `modelToDb` adaptation happens once, explicitly, at the diplomat handler — never inside `diplomat/db`.**
  The handler that calls `runEffects` maps the controller's `FlowOutcome` through the entity's own
  `outcomeToDb` (`adapters/accounts.ts`) *before* handing it to `runEffects`, converting every `Persistable`'s
  domain-shaped `model` into a db row (baking in `INITIAL_VERSION` for an insert). By the time `runEffects`
  or the entity's `EntityApplier` (`diplomat/db/repos/accounts.ts`'s `accountApplier`) sees a `Persistable`, its
  `model` is already a row — the applier only ever writes it, never adapts it. This is the boundary-adaptation
  rule from earlier in this doc ("diplomats adapt `wire/in -> model` before controller calls and `model ->
  wire/out` after") extended one step further: the same handler also adapts `model -> db row` between the
  controller and the shell.
- **Appliers are registered, never branched on.** An entity's `EntityApplier` lives beside its other persistence
  code (e.g. `diplomat/db/repos/accounts.ts`) and is registered once in the `ApplierRegistry` at the composition
  root (`main.ts`); nothing in FinTrack special-cases an entity tag around the engine.
- **Don't hand-write an `EntityApplier` for a table that already fits the `id`/`version` convention** — call
  `versionedTableApplier(table)` (`diplomat/db/effects.ts`) instead. `accountApplier` is
  `versionedTableApplier(accounts)`, nothing more: once the model→row adaptation moved to the handler (above),
  an applier's `insert`/`update`/`delete` became identical mechanics for every table shaped that way (cast the
  row, write it, guard on `version`). A table with a secondary `UNIQUE` column beyond `id` (`tags.name`,
  `dashboards.name`) still uses `versionedTableApplier` for `update`/`delete`, wrapping only `insert` to catch
  the `UNIQUE` race and rethrow `VersionConflict` (`tagApplier`/`dashboardApplier`). Only hand-write a fully
  custom `EntityApplier` for a table that doesn't fit the convention at all (no `id`/`version`, e.g. the
  key-only link tables).
- Composition (a flow that orchestrates another controller) **merges** `persist` arrays — take the called
  controller's `persist`, add your own, return the merged batch; don't apply either separately.
- A converted controller's `deps` still exposes reads (`deps.<x>.list/find/...`) — the purity boundary is
  writes, not all I/O. Only the write call moves from `await deps.<x>.create(...)` to
  `persistence.insert({ entity: ACCOUNT_ENTITY_TAG, model: account })`.

#### Controller shape — gather, decide, persist

A controller reads in three named steps: **gather** (resolve refs, repo reads through `deps`), **decide** (one
pure `logic/` call from the gathered values to an entity, guards and data), **persist** (build `{ persist, response }`).
Rules belong in the decide step, where they are unit-tested without mocks; the function-shape lint limits
(`docs/canonical/code-quality.md` § Function shape) hold the controller to it.

```ts
// ✅ DO — gather in the controller, the decision is a pure plan call, then persist
const categorySelection = yield* resolveCategorySelection(deps, input, type)       // gather
const plan = planNewTransaction({                                                    // decide (logic/transaction.ts)
  id: deps.newId(), today: toIsoDate(deps.clock()), input, type, source, currency,
  decimals: await resolveDecimals(deps, currency),
  funding: { refs: { accountId: account?.id }, sourceId: account?.id },
  categorySelection, candidates: await matchCandidatesFor(deps, input.description, categorySelection),
  keepsUnmatchedMerchant: true,
})
const persist = [persistence.insert({ entity: TRANSACTION_ENTITY_TAG, model: plan.entity, idempotencyKey: plan.idempotencyKey })]

// ❌ DON'T — status default, classification, entity literal and key derivation written inline in the controller
const status = input.status ?? defaultStatusFor(date, today)
const classification = categorySelection ? userClassification(...) : pickClassification(await deps.merchants.matchCandidates(...))
const entity: TransactionEntity = { id: deps.newId(), /* … 15 fields … */ }
```

### logic/ — pure and declarative

- No I/O, no `Date.now()`/`new Date()` (clock comes from deps), no imports from `controllers/` or `diplomat/`.
- Data transformation with **[remeda](https://remedajs.com/docs/)** when ≥2 stages or grouping is involved (ADR-003):

```ts
// ✅ DO
export const summarize = (rows: readonly SummaryRow[]) =>
  R.pipe(rows, R.groupBy((r) => r.currency), R.entries(), R.map(toCurrencySummary), R.sortBy((s) => s.currency))

// ❌ DON'T
const currencies = [...new Set(rows.map((r) => r.currency))].sort()
return currencies.map((currency) => { const mine = rows.filter(...); ... })  // manual grouping
```

- Native `map`/`filter` is fine for single-stage transforms.
- **Guard conditions belong here when pure.** Extract a reusable boolean precondition into a named
  predicate (e.g. `assertNonCreditType(type)`) instead of inlining `x !== Enum.value` at the `guard` call.
  Predicates are trivially unit-tested and reused across create/update/delete. (Repo-dependent conditions
  can't be pure — keep those as small async helpers in the controller.)
- Every logic function gets a mirrored `test/unit/logic/*.test.ts` (vitest) — pure functions, no mocks.

### Testing requirements

- Behavior changes MUST include unit tests in the same change.
- New logic functions MUST ship with a matching test under `test/unit/logic/`; controller/repo/adapter changes
  MUST update or add focused unit tests that cover success and expected-failure paths.
- Prefer small, deterministic tests; avoid network/db side effects in unit tests.

### models/ — zod single source of truth

- **Every type and constant lives in `models/`** — plan/facts shapes (`NewTransactionFacts`, `BillPaymentPlan`), `Extract`ed unions, sentinels (`INVALID_REDEEM`), key prefixes. `controllers/` and `logic/` hold functions only; a type a function needs is imported, never declared beside it. Plan/facts types are hand-written TypeScript — they are not domain data, so not zod; domain data stays `z.infer`. The exceptions are shapes that cannot live there: ports that name `diplomat/` types or the composed `AppError` (`controllers/deps.ts`, `StatementImportPlan`) and function-valued dispatch tables.

- Types are ALWAYS `z.infer<typeof Schema>` — never hand-written interfaces for domain data.
- **Naming: the zod value gets the `Schema` suffix; the inferred type gets the bare name.**
  `export const AccountSchema = z.object({...})` + `export type Account = z.infer<typeof AccountSchema>`.
  Derived schemas keep the suffix (`CreateAccountSchema`, `UpdateAccountSchema`) with bare-name types
  (`CreateAccount`, `UpdateAccount`). This removes the value-vs-type ambiguity at import sites.
- Distinguish input schemas (`CreateTransactionInput` — names, optional fields) from entity
  schemas (`Transaction` — ids, resolved). Inputs use `MovementType`; only entities carry
  `TransactionType` (which includes `'transfer'`).
- **A shared core schema composes UP (`.extend`), never carries the union for aggregates to carve
  DOWN (`.omit`) (ADR-019).** A field/rule/error belongs on the shared core schema only if the
  shared read/balance/persistence side is genuinely defined over it; anything a single aggregate
  introduces is defined in that aggregate's own model file and layered onto the core with
  `.extend`, never named on the core for the aggregate to `.omit` away:

  ```ts
  // models/transaction.ts (core) — minimal, shared movement vocabulary only
  export const CreateTransactionSchema = z.object({ description, amount, type, status, date, ... })
  // no account, no card, no billMonth/billYear — those are a single aggregate's vocabulary

  // models/credit-card.ts — composes UP: adds card-only fields the core never carries
  export const AddCardPurchaseSchema = CreateTransactionSchema.extend({ card, billMonth, billYear }).strict()

  // models/account.ts — composes UP: adds its own field, omits the create-only type discriminator
  export const AddAccountMovementSchema = CreateTransactionSchema.extend({ account }).omit({ type: true }).strict()
  ```

  Field-tied errors move with their field to the aggregate that owns it (e.g. `billPeriodIncomplete`
  lives in `credit-card.ts`'s `cardErrors`, not the core's `transactionErrors`, since only a
  card-context schema can carry `billMonth`/`billYear` at all). The one carve-out: a read/balance/
  summary concern that's *structurally* defined over a value common to every aggregate (e.g. the
  transfer row kind, `TransactionView`'s discriminator fields) stays on the core even though a
  single aggregate owns the *policy* around it — the test is "does the shared read/persistence side
  need this," not "does only one caller set it."
- **`.describe()` is domain info — put it on the model field**, not re-authored at the edge. It says
  what the field *is*; the MCP/REST edge derives its schema (`Schema.shape`) so the same text surfaces.
- **Defaults by intent:** integrity defaults (a value that must exist for validity, e.g.
  `initialBalance: z.number().default(0)`) go on the **domain** schema; not-null fields stay **required**
  in the model. Quality-of-life defaults (convenience when omitted, e.g. currency → USD) go on the
  **wire** schema via `.extend` — never weaken the domain contract for caller convenience.

  ```ts
  // models/account.ts — domain: currency is required (integrity), described once
  currency: CurrencyCode.describe('Account currency (ISO code); fixed once the account has activity'),
  // wire/in/accounts.ts — boundary: QoL default only
  export const CreateAccountSchema = modelAccount.CreateAccountSchema.extend({
    currency: CurrencyCode.default(CurrencyCode.enum.USD),
  })
  ```

- **Expected-error payloads live with the entity (ADR-012).** Each model defines its own error union
  (e.g. `AccountError`) typed against shared primitives from `models/error.ts`, and colocates payload
  builders. Models never import the composed `AppError`:

  ```ts
  // models/account.ts
  import type { DuplicateName, ValidationError } from './error.js'

  export type AccountError = DuplicateName<'account'> | ValidationError

  export const accountErrors = {
    creditRejected: { code: 'validation', issues: ['…use the card flow…'] } satisfies AccountError,
    duplicateName: (name: string): AccountError => ({ code: 'duplicate_name', entity: 'account', name }),
  }
  ```

  Controllers raise them; they never inline the `{ code, … }` literal (see "Constants over literals" under Code quality, below).

### diplomat/ — thin, no business logic

- http/mcp handlers: zod-parse (`wire/in`) → adapt to model → call controller → adapt model to `wire/out`
  → translate Result. Nothing else.
- db: parameterized SQL ONLY — use Drizzle's query builder or the `sql` template tag; never
  string-interpolate user input (security bug). Decode every row through `wire/db` + `adapters/` zod parsing.
- Edge and shell expected failures follow the same Result convention as controllers: a `Result`/`ResultAsync` whose error is a plain discriminated object (`{ code, … }`), never a thrown `Error` subclass — a throwing third-party API (`node:fs`, the OS keychain, `readline`) is wrapped exactly once, at the adapter (`Result.fromThrowable` / `ResultAsync.fromPromise`), and only unexpected failures throw.
- One named definition per route and per tool; the module exports the list and registration is generic
  (`docs/architecture.md` § Diplomat edge organization). A handler is decode → delegate → map, ~10 lines:

  ```ts
  // ✅ DO — HTTP: metadata is data, the handler uses the shared helpers
  const deleteTagRoute: RouteDefinition = {
    method: 'delete', scope: WRITE_SCOPE, path: '/api/tags/:id', tags: [TAGS_TAG], summary: 'Delete tag',
    request: { params: idParam }, responses: { 200: okResponse('Tag deleted', DeletedOut) },
    handler: async (req, reply, scope) => {
      const { deps, runEffects } = scope()
      const flow = () => deleteTag(deps, pathParam(req, 'id')).map(tagAdapters.outcomeToDb)
      return send(reply, await runEffects(flow))
    },
  }
  export const tagRoutes = [listTagsRoute, createTagRoute, deleteTagRoute]

  // ✅ DO — MCP: name from ToolName, long description a named constant, handler gets the scoped deps
  const deleteTagTool = defineTool({
    name: ToolName.enum.delete_tag,
    config: { annotations: MUTATING, title: 'Delete tag', description: deleteTagDescription, inputSchema },
    handle: async (args, { deps, runEffects }) =>
      fromResult(await runEffects(() => deleteTag(deps, args.id).map(tagAdapters.outcomeToDb))),
  })
  export const tagTools = [listTagsTool, createTagTool, deleteTagTool]

  // ❌ DON'T — an inline 422 literal, a bare tool name, a registration function wrapping every handler
  if (!parsed.success) return reply.status(422).send({ error: { code: 'validation', issues: ['…'] } })
  server.registerTool('delete_tag', { … }, async (args, extra) => { const { deps } = ctx.as(extra); … })
  ```

- New MCP tools: rich `description` (the agent reads it!), `.describe()` on non-obvious fields,
  documented in `docs/mcp-tools.md` in the same change.

### Schema validation requirements (Zod)

- Every external boundary must validate with Zod before entering the domain (HTTP/MCP inputs, DB records,
  and external client/resource payloads).
- Use schema parsing (`parse`/`safeParse`) at the boundary; do not pass unvalidated unknown data to
  controllers, logic, or models.
- Prefer `safeParse` when returning expected validation errors on the Result track; use `parse` when a
  throw-on-invalid boundary is intentional and handled at the edge.

### adapters/ and wire/

- Adapters are pure translators for boundary directions: `wireInToModel`, `modelToWireOut`, `modelToDb`,
  `dbToModel`.
- Use namespace imports for clarity at call sites, e.g. `import * as transactionAdapters from ...` then
  `transactionAdapters.modelToDb(...)`.
- Wire contracts belong under `src/wire/in`, `src/wire/out`, and `src/wire/db`; do not place boundary
  contracts in `models/`.

### Naming & misc

- Files and folders: kebab-case matching the domain (`credit-cards.ts`); tests live under `test/unit/`/`test/integration/`
  in a mirrored path, not colocated (`test/unit/logic/bill.test.ts`, never `src/logic/bill.test.ts` — see
  `CLAUDE.md`'s Commands section; the vitest config only scans `test/unit/**`/`test/integration/**`, so a
  colocated `src/**/*.test.ts` file silently never runs).
- IDs `crypto.randomUUID()` via `deps.newId()`; seeds use stable slugs (`cat-transporte`).
- Dates are `YYYY-MM-DD` strings end-to-end; month math in pure logic (`period.ts`, `recurring.ts`),
  never via timezone-prone `Date` arithmetic on day-of-month.
- User-facing strings (descriptions, category names) may be Portuguese; identifiers and comments in English.


## Code quality (applied)

These principles apply to every line of code written in this repo. They are non-negotiable.
`docs/canonical/code-style.md` covers implementation principles; the code-style section above applies them with safeTry, remeda and zod; this document
covers the underlying quality rules that govern all choices.

### Constants over literals

Never pass a magic string or number where a named constant exists.

```ts
// ✅ DO
source: TransactionSource.enum.mcp
kind: CategoryKind.enum.expense

// ❌ DON'T
source: 'mcp'
kind: 'expense'
```

- Zod enums expose `.enum` — always use it at call sites.
- If the value is used in more than one place, define a constant; do not copy-paste the literal.
- This applies to error codes, status strings, numeric thresholds, and any other repeated value.
- **`AppError` payloads are not inline literals either.** Colocate them as named constants/builders on the
  entity's model (`accountErrors.creditRejected`, `accountErrors.duplicateName(name)`) and reference them at
  the `guard`/`err` call. An inline `{ code: 'validation', issues: ['…'] }` in a controller is the same smell
  as a bare string — it scatters domain vocabulary and duplicates messages. (See "models/" under Code style, above.)

  ```ts
  // ✅ DO
  yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected)

  // ❌ DON'T
  yield* guard(input.type !== AccountType.enum.credit, { code: 'validation', issues: ['…'] })
  ```

### Naming clarity

Names should make the reader's job effortless. No abbreviations, no acronyms unless universally
known (`id`, `url`, `mcp`).

```ts
// ✅ DO
const resolveEffectiveType = ...
const guardTransferMutability = ...

// ❌ DON'T
const getType = ...
const checkTransfer = ...
```

- Functions: verb + noun describing what they do (`createTransaction`, `guardCategoryKind`).
- Booleans: `is*`, `has*`, `can*`, `needs*` (`isUserCorrection`, `needsReview`).
- Variables: name the domain concept, not the type (`account`, not `accountResult`).
- Files and folders under `src/`, `test/`, `ui/` and `scripts/` are kebab-case (`credit-card.ts`, `sign-in/`), enforced by lint (`eslint-plugin-check-file`).
- A domain with more than one file in a layer gets a folder in that layer, and its files drop the folder's name (`logic/demo/plan.ts`, `logic/demo/database.ts`, not `logic/demo.ts`, `logic/demo-database.ts`).

#### Names carry the context of their module — don't repeat it

A function name should not restate the file or namespace it lives in. The call site already
provides that context via the import or namespace prefix.

```ts
// ✅ DO — file is adapters/transactions.ts, imported as transactionAdapters.*
export const modelToDb = ...
export const dbToModel = ...
export const wireInToModel = ...

// at call site: transactionAdapters.modelToDb(entity)  — "transaction" is clear from the prefix

// ❌ DON'T — redundant: the file name already says "transactions"
export const modelTransactionToDb = ...
export const transactionDbToModel = ...
```

```ts
// ✅ DO — file is logic/transaction.ts
export const resolveCurrency = ...      // not resolveTransactionCurrency
export const guardTransferMutability = ... // not guardTransactionTransferMutability

// ✅ DO — file is controllers/categories.ts
export const createSubCategory = ...    // not createCategorySubCategory
```

When two exports from different modules would collide at a call site, rely on namespacing
rather than adding redundant words to the name:

```ts
// ✅ DO
import * as transactionAdapters from './adapters/transactions.js'
import * as categoryAdapters from './adapters/categories.js'
transactionAdapters.modelToDb(...)
categoryAdapters.modelToDb(...)

// ❌ DON'T — solve collision by polluting the name
transactionModelToDb(...)
categoryModelToDb(...)
```

### Single responsibility

One function, one job. If you find yourself writing "and" in a function description, split it.

```ts
// ✅ DO — each function has one reason to change
const resolveCurrency = (account, card, input) => ...
const guardTransferMutability = (existing, input) => ...

// ❌ DON'T — resolves AND guards AND derives
const prepareTransactionUpdate = (existing, input, deps) => ...
```

- Extract when a block of code could be named and tested independently.
- Controllers orchestrate; logic functions compute; adapters translate. Never mix.

### No magic values

Every non-obvious literal needs a name or a comment explaining why that value.

```ts
// ✅ DO
const MAX_BULK_ITEMS = 200
const LOW_CONFIDENCE_THRESHOLD = 0.6

// ❌ DON'T
.max(200)
if (c.confidence < 0.6)
```

Thresholds, limits, and domain constants belong in `models/` with a name that
encodes intent.

### Declarative over imperative

Prefer expressions that describe *what* the result is over statements that describe *how* to
build it. Reach for [remeda](https://remedajs.com/docs/) before writing a loop.

```ts
// ✅ DO
const counts = R.countBy(items, (i) => i.status)
const totals = R.pipe(rows, R.groupBy((r) => r.currency), R.mapValues(R.sumBy((r) => r.amount)))
const active = R.filter(rules, R.anyPass([isRecent, isHighPriority]))

// ❌ DON'T
let counts: Record<string, number> = {}
for (const item of items) {
  counts[item.status] = (counts[item.status] ?? 0) + 1
}
```

In `src/logic/`, `src/controllers/` and `src/adapters/` this is enforced by lint (`eslint.config.js`): loops (`for`, `for…of`, `for…in`, `while`, `do…while`), `let` and `.push(` are errors there. The shell (`diplomat/**`) and the composition root (`composition/**`) are exempt.

Two more rules hold repo-wide (`src/**`, `test/**`): `@typescript-eslint/consistent-type-imports` (a type is imported as a type: `import { a, type B } from 'm'`) and `no-duplicate-imports` (one import per module).

Remeda functions to prefer over manual imperative equivalents:

| Instead of… | Use… |
|---|---|
| `let count = 0; for...` | `R.countBy` |
| `arr.reduce((acc, x) => ..., {})` | `R.groupBy`, `R.mapValues`, `R.sumBy` |
| `if (a \|\| b \|\| c)` on functions | `R.anyPass([...])` |
| `if (a && b && c)` on functions | `R.allPass([...])` |
| chained `.filter().map().sort()` | `R.pipe(...)` |
| `{...a, ...b, ...c}` across many objects | `R.mergeAll([...])` |
| `arr.find(fn) ?? fallback` | `R.firstBy` |
| `switch` over a value to transform it | `R.conditional` |
| `() => fixedValue` | `R.constant(fixedValue)` |

The rule of thumb from `docs/canonical/code-style.md` still applies: native `map`/`filter` is fine for
single-stage transforms. Reach for remeda when there are ≥2 stages, grouping, counting, or
predicate composition.

#### Named logic functions over inline lambdas in pipes

Extract inline predicates and mappers into named functions in the `logic/` layer. A pipe should
read as a sequence of *what* happens — named functions provide that; inline `(a) => ...` lambdas
bury the intent.

```ts
// ✅ DO — named functions in logic/, pipe reads declaratively
// logic/account.ts
export const filterByType = (type?: AccountType) => (a: Account): boolean =>
  !type || a.type === type

// controller
return R.pipe(
  all,
  R.filter(filterByType(type)),
  R.map(withTypeLabel(locale)),
)

// ❌ DON'T — inline lambdas obscure intent
return R.pipe(
  all,
  R.filter((a) => !type || a.type === type),
  R.map((a) => withTypeLabel(a, locale)),
)
```

#### Custom helpers with `purry` (dual data-first / data-last)

When a custom helper is used both imperatively and in pipes/map, wrap it with `purry` to
support both calling conventions — the same pattern every Remeda function uses.

```ts
// ✅ DO — purry enables both styles with one function
import { purry } from 'remeda'

const _withTypeLabel = <T extends Account>(account: T, locale: Locale): T => ({
  ...account,
  typeLabel: localizeAccountType(account.type, locale),
})

export function withTypeLabel<T extends Account>(account: T, locale: Locale): T
export function withTypeLabel(locale: Locale): <T extends Account>(account: T) => T
export function withTypeLabel(...args: readonly unknown[]) {
  return purry(_withTypeLabel, args)
}

// data-first (imperative)
withTypeLabel(account, locale)

// data-last (pipes / map)
R.pipe(accounts, R.filter(filterByType(type)), R.map(withTypeLabel(locale)))

// ❌ DON'T — manual curry forces awkward double-call at imperative sites
const withTypeLabel = (locale: Locale) => (account: Account) => ({ ... })
withTypeLabel(locale)(account)  // reads poorly outside pipes
```

### Avoid unnecessary complexity

Write the simplest code that correctly solves the problem. Do not:

- Add abstraction layers before there are at least three concrete cases.
- Use generics when a concrete type works.
- Add configuration options for behaviour that has never varied.
- Reach for a library when three lines of TypeScript do the job.

The test: if you deleted the abstraction and inlined the logic, would the code be harder to
understand? If not, keep it simple.

### Static imports over inline dynamic `import()`

Keep imports at the top of the file. Reach for a static `import` by default — dynamic `import()`
scattered through a function body hides a dependency from the reader (and from tooling) and is
harder to reason about than a plain top-of-file import.

The one sanctioned exception is a genuine **lazy-load gate**: a module that is expensive or has
side effects on load (e.g. Fastify and the route table it registers) and is only needed for some
runtime-conditional path (a config flag, a CLI subcommand) — not merely "used in one branch of
this function." Even then:

- Isolate the `import()` inside a single small, named, module-scope function — never inline it as
  part of a larger expression or chain a second `await` off its result.
- Document *why* it's lazy: what it avoids loading, and for which runtime path.
- If more than one call site needs the same lazy module, share the one function — don't repeat
  the `import('./path.js')` literal (see "Constants over literals" above).

```ts
// ✅ DO — one named function owns the dynamic import; call sites stay plain
const loadServerModule = () => import('./server.js') // Fastify never loads in default stdio mode (ADR-007)

const maybeStartSidecar = async (deps, version, config) => {
  if (!config.FINTRACK_HTTP) return null
  const { startHttpSidecar } = await loadServerModule()
  return startHttpSidecar(deps, version, config.PORT)
}

// ❌ DON'T — import() inline, chained mid-expression, buried in control flow
const sidecar = config.FINTRACK_HTTP
  ? await (await import('./server.js')).startHttpSidecar(deps, version, config.PORT)
  : null
```

If there's no genuine runtime-conditional load-avoidance reason, just use a static import — don't
reach for `import()` to "organize" code or defer work that isn't actually optional.

### Function shape

Small functions with one level of branching read at a glance. The limits below are enforced by lint
(`eslint.config.js`) on all of `src/**` (the switch-size rule is a lint error repo-wide):

| Limit | Value |
|---|---|
| Lines per function (blank lines and comments excluded) | 40 |
| Cyclomatic complexity | 10 |
| Nesting depth | 3 |
| Statements per function | 15 |

#### Exhaustive tables instead of big switches

A `switch` of 7 or more `case`/`default` labels (`SwitchStatement > SwitchCase:nth-child(7)`, lint) is a lookup in disguise. Write
the table: the `Record` key type makes the compiler reject a missing key, and the lookup is one line.

```ts
// ✅ DO — HTTP status as data; a new error code that is not listed fails typecheck
const HTTP_STATUS = { unknown_account: 404, validation: 422 /* … */ } as const satisfies Record<AppError['code'], number>
export const httpStatus = (e: AppError): number => HTTP_STATUS[e.code]

// ✅ DO — each formatter receives its own narrowed error
type Formatters = { [C in AppError['code']]: (e: Extract<AppError, { code: C }>) => string }
const FORMATTERS: Formatters = { unknown_transaction: (e) => `${e.code}: ${e.id}` /* … */ }
export const formatAppError = (e: AppError): string => (FORMATTERS[e.code] as (e: AppError) => string)(e)

// ❌ DON'T — 34 `case` labels the compiler only checks through a `never` default
switch (e.code) { case 'unknown_account': case 'unknown_category': /* … */ return 404 }
```

The one cast sits at the lookup because TypeScript cannot correlate `e.code` with the handler picked by it;
the table's own type is what proves every key has a handler of the right shape. Split a long table by family
(one `satisfies Formatters<…>` sub-table per family, spread into the whole) so no literal spans screens.

#### The controller sandwich

A controller is three steps, each one a named call: **gather** (reads, I/O through `deps`), **decide** (one pure
`logic/` call that returns a plan), **persist** (the plan → `{ persist, response }`). It should read in under ten
lines; the rules live in the decide step, where they are unit-tested without mocks.

```ts
// ✅ DO — the update's decision is one pure call; the controller reads, calls it, persists
export const updateCardTransaction = (deps: Deps, input: UpdateCardTransaction) =>
  safeTry(async function* () {
    const { existing, cardId } = yield* loadOwnCardTransaction(deps, input.id)            // gather
    yield* guardCardPatch(input)
    const { reassignedBillId } = yield* resolveBillReassignment(deps, cardId, existing, input)
    const { categorySelection } = yield* decideTransactionUpdate(deps, input, existing)
    const entity = mergePatch(existing, input, categorySelection, { billId: reassignedBillId }) // decide (pure, logic/)
    return ok(toOutcome(entity))                                                          // persist: { persist, response }
  })

// ❌ DON'T — reads, rules and write-building interleaved in one body: every `input.x ?? existing.x`,
// the note rule, the user-correction classification and the category/sub-category pick re-written inline
// in each aggregate's update, past the statement and complexity limits
```

Extract by meaning, not by count. A decision that is a function of already-read values (`mergePatch`,
`planNewTransaction`, `planBillPayment`) moves to `logic/` and gets unit tests; a read stays in the controller or a
named gather helper beside it (`resolveSearchRefs`). Nothing in `logic/` gains I/O or a `deps` parameter. A helper
with eight positional parameters or a `doStep1`/`doStep2` chain is worse than the function it replaced — pass one
facts object and name the concept it computes.

#### One named definition per tool / route

Each MCP tool and HTTP route is its own named definition (`const createAccountTool = …`). Its handler only
parses (`wire/in`), delegates to the controller and translates the result; the module's job is to export the list.

```ts
// ✅ DO
const createAccountTool = defineTool({
  name: ToolName.enum.create_account,
  config: { annotations: MUTATING, title: 'Create account', description: createAccountDescription, inputSchema },
  handle: async (args, { deps, runEffects }) => fromResult(await runEffects(() => createAccount(deps, args))),
})
export const accountTools = [createAccountTool, listAccountsTool]

// ❌ DON'T — a registration function with every handler inlined in its body
export const registerAccountTools = (server) => { server.tool('create_account', …, async (args) => { /* 60 lines */ }) /* … */ }
```

All of `src/**` is held to the four limits above by lint; a handler that outgrows them is orchestration that belongs in a
controller (or a shared, named step), and a controller that outgrows them is missing a `logic/` plan function or a named
gather helper — not a reason to disable the rule.

#### The shell: a factory binds, queries are named functions

A repo factory has one job: bind the scope and hand each method to a named query. The query bodies sit at module level over
that scope, so the tenancy filter is visible in the query and no object literal grows with the number of methods. An
applier is built the same way: a small context, built once, and one named function per operation.

```ts
// ✅ DO — the factory binds; each query is a named function over the scope
const search = async ({ db, userId }: RepoScope, input: SearchTransactions, refs: ResolvedSearchRefs) => { /* … */ }
export const transactionsRepo = (db: Db, userId: string): TransactionsRepo => {
  const scope: RepoScope = { db, userId }
  return { search: (input, refs) => search(scope, input, refs), count: (input, refs) => count(scope, input, refs) }
}

// ✅ DO — an applier: a context built once, one named function per operation, the loud invariants named
const applierFor = (table, owner, { readBack }) => {
  const ctx = tableContextFor(table, owner, readBack)
  return { insert: insertRow(ctx), update: updateRow(ctx), delete: deleteRow(ctx), check: checkRow(ctx) }
}

// ❌ DON'T — every query body inside the object the factory returns
export const transactionsRepo = (db: Db, userId: string): TransactionsRepo => ({
  search: async (input, refs) => { /* 20 lines */ },
  aggregate: async (filters) => { /* 25 lines */ },
  /* … */
})
```

Extract by meaning here too: a branchy `insert` becomes `assertKeyMatchesTable`, `rowToInsert`, `conflictTarget`,
`persistedIdAfter` — each one a decision a reader can name — rather than a `step1`/`step2` split.

### Fail loudly at boundaries, trust internally

- Validate with zod at every external boundary (HTTP, MCP, DB records). See `docs/canonical/code-style.md`.
- Inside the domain, trust your own types — do not re-validate data you already decoded.
- Do not add defensive `if (x == null)` checks on values the type system guarantees are non-null.

### Consistency over cleverness

When a pattern already exists in the codebase, follow it. Introduce a new pattern only when
the existing one genuinely does not fit, and document the reason.

Examples of patterns to follow consistently:
- All name resolution via `controllers/resolve.ts` helpers.
- All result types from controllers as `ResultAsync<T, AppError>`.
- All boundary adaptation in `adapters/` following the `wireInToModel` / `modelToWireOut` convention.
- All enum values referenced via `.enum.*`, never as string literals.
