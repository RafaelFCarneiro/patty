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
`Persistable` (`models/persistable.ts`) via the `logic/persistence.ts` builders, and returns it alongside the
response, for the diplomat shell's `withUnitOfWork` (`diplomat/db/unitOfWork.ts`) to apply:

```ts
// ✅ DO — the core decides and returns the write as data; it never calls a repo write method
export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<FlowOutcome<Account>, AppError> =>
  safeTry(async function* () {
    yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected)
    yield* guard(await assertNameAvailable(deps, input.name), accountErrors.duplicateName(input.name))

    const account: Account = { id: deps.newId(), ...input }  // no version — a new row's is the shell's constant
    const persist: Persistable[] = [persistence.insert({ entity: EntityTag.enum.account, model: account })]
    return ok({ persist, response: account })
  })

// the diplomat handler (MCP tool / REST route) wraps the call — this is the shell applying the effect
async (args) => fromResult(await unitOfWork(() => createAccount(deps, accountAdapters.createWireInToModel(args))))

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
  each call site. The write intent (`op`) these set is a named enum (`PersistOp`), not a bare
  `'insert'`/`'update'`/`'delete'` string — same "constants over literals" rule as `EntityTag`.
- An `insert` `Persistable`'s model is the plain, wire-shaped domain model (`Account`) — **no `version`**. A
  brand-new row's version is always the same structural constant (`INITIAL_VERSION`, `diplomat/db/
  unitOfWork.ts`); that's not a decision the core makes, so it never appears in what the core builds or
  returns. The response is that same model — nothing to strip. `update`/`delete` are different: `version` is
  the value the core actually read, so it's real data the model carries (`AccountEntity` — `Account` +
  `version`). The shell computes the *persisted* version from it (`model.version + 1`, in application code) —
  never as an opaque `version + 1` SQL expression left for the database engine to evaluate; the database never
  owns version bookkeeping on its own.
- Composition (a flow that orchestrates another controller) **merges** `persist` arrays — take the called
  controller's `persist`, add your own, return the merged batch; don't apply either separately.
- A converted controller's `deps` still exposes reads (`deps.<x>.list/find/...`) — the purity boundary is
  writes, not all I/O. Only the write call moves from `await deps.<x>.create(...)` to
  `persistence.insert({ entity: EntityTag.enum.account, model: account })`.

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
