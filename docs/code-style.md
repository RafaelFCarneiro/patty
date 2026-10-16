# Code style & generation guidelines

Rules with examples — follow these when writing ANY code in this repo. The do/don't pairs below
come from real refactors; generating in the "don't" style means the code will be rewritten.

## General

- TypeScript strict, ESM with NodeNext: **relative imports end in `.js`** (`from './driver.js'`).
- `const` + expressions over `let` + mutation. Arrow functions. No classes anywhere in the domain
  (the only acceptable class usage is library-provided, e.g. the MCP SDK server).
- Prefer small named functions over inline complexity; extract when a function does two things.
- Comments explain *why* (invariants, trade-offs), never *what* the code already says.

## Controllers — safeTry composition (Railway-Oriented)

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

### Write-path controllers — return effects, don't perform them (ADR-021)

**In progress — not every controller is converted yet.** `docs/functional-core-imperative-shell.md` is the
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

## logic/ — pure and declarative

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

## Testing requirements

- Behavior changes MUST include unit tests in the same change.
- New logic functions MUST ship with a matching test under `test/unit/logic/`; controller/repo/adapter changes
  MUST update or add focused unit tests that cover success and expected-failure paths.
- Prefer small, deterministic tests; avoid network/db side effects in unit tests.

## models/ — zod single source of truth

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

  // models/creditCard.ts — composes UP: adds card-only fields the core never carries
  export const AddCardPurchaseSchema = CreateTransactionSchema.extend({ card, billMonth, billYear }).strict()

  // models/account.ts — composes UP: adds its own field, omits the create-only type discriminator
  export const AddAccountMovementSchema = CreateTransactionSchema.extend({ account }).omit({ type: true }).strict()
  ```

  Field-tied errors move with their field to the aggregate that owns it (e.g. `billPeriodIncomplete`
  lives in `creditCard.ts`'s `cardErrors`, not the core's `transactionErrors`, since only a
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

  Controllers raise them; they never inline the `{ code, … }` literal (see code-quality "Constants over literals").

## diplomat/ — thin, no business logic

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

## Schema validation requirements (Zod)

- Every external boundary must validate with Zod before entering the domain (HTTP/MCP inputs, DB records,
  and external client/resource payloads).
- Use schema parsing (`parse`/`safeParse`) at the boundary; do not pass unvalidated unknown data to
  controllers, logic, or models.
- Prefer `safeParse` when returning expected validation errors on the Result track; use `parse` when a
  throw-on-invalid boundary is intentional and handled at the edge.

## adapters/ and wire/

- Adapters are pure translators for boundary directions: `wireInToModel`, `modelToWireOut`, `modelToDb`,
  `dbToModel`.
- Use namespace imports for clarity at call sites, e.g. `import * as transactionAdapters from ...` then
  `transactionAdapters.modelToDb(...)`.
- Wire contracts belong under `src/wire/in`, `src/wire/out`, and `src/wire/db`; do not place boundary
  contracts in `models/`.

## Naming & misc

- Files: camelCase matching the domain (`creditCards.ts`); tests live under `test/unit/`/`test/integration/`
  in a mirrored path, not colocated (`test/unit/logic/bill.test.ts`, never `src/logic/bill.test.ts` — see
  `CLAUDE.md`'s Commands section; the vitest config only scans `test/unit/**`/`test/integration/**`, so a
  colocated `src/**/*.test.ts` file silently never runs).
- IDs `crypto.randomUUID()` via `deps.newId()`; seeds use stable slugs (`cat-transporte`).
- Dates are `YYYY-MM-DD` strings end-to-end; month math in pure logic (`period.ts`, `recurring.ts`),
  never via timezone-prone `Date` arithmetic on day-of-month.
- User-facing strings (descriptions, category names) may be Portuguese; identifiers and comments in English.
