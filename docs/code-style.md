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
- Every logic function gets a colocated `*.test.ts` (vitest) — pure functions, no mocks.

## Testing requirements

- Behavior changes MUST include unit tests in the same change.
- New logic functions MUST ship with colocated tests; controller/repo/adapter changes MUST update or add
  focused unit tests that cover success and expected-failure paths.
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

## Multi-write flows — "delta in, outcome out" idiom (ADR-015)

When a controller flow needs more than one repo write, it assembles a fully-decided **typed delta** in
`models/` (e.g. `TransactionUpdateDelta`) and hands it to **one transactional repo method** in
`diplomat/db`. All writes happen inside a single `db.transaction`; any last-instant CAS check is a SQL
predicate. The repo reports what happened as a **typed outcome** — never by throwing for expected outcomes.

```ts
// models/transaction.ts — fully-decided write intent, assembled by the controller
export type TransactionUpdateDelta = {
  patch: TransactionPatch;
  refs: TransactionRefsPatch;
  reassignment?: { cardId: string; period: BillPeriod };
  classificationStrengthen?: { categoryId: string };
};

export type UpdateOutcome =
  | { applied: true; row: RawTransactionView }
  | { applied: false; conflict: 'bill_paid' };  // discriminant is data, not a message

// diplomat/db/repos/transactions.ts — one transaction, outcome as data
applyUpdate: async (id, delta, newId) => {
  try {
    await db.transaction(async (tx) => {
      // ...all writes via tx; on a CAS miss:
      // throw rollbackSentinel('bill_paid')  ← triggers rollback; never escapes the API
    });
  } catch (e) {
    if (isRollbackSentinel(e)) return { applied: false, conflict: e.conflict };
    throw e;  // unexpected → 500
  }
  // Read committed state after transaction commit.
  const row = await fetchTx(db, id);
  return { applied: true, row };
};

// controllers/transactions.ts — maps the typed conflict to the domain error
const outcome = await deps.transactions.applyUpdate(id, delta, deps.newId);
const row = yield* okOr(outcome.applied ? outcome.row : null, transactionErrors.paidBillImmutable);
```

Key rules:
- The delta type lives in `models/` next to the entity's patch types (`TransactionPatch` precedent).
- **One flow, one named delta type.** No generic `Delta<Op[]>` that degrades into an untyped list.
- The sentinel throw exists only **inside the repo method** to trigger `db.transaction` rollback. The method's return type is always `Promise<Outcome>` — no throws for expected cases.
- The controller owns **meaning**: the CAS predicate is parameterized data; only the controller decides what a conflict means and maps it to an `AppError`.
- `applyDueRecurring` is the documented exception: idempotent replay (stable `rec-<ruleId>-<date>` keys) is the legitimate alternative to atomicity for batch materialization.


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

- Files: camelCase matching the domain (`creditCards.ts`); tests colocated (`bill.test.ts`).
- IDs `crypto.randomUUID()` via `deps.newId()`; seeds use stable slugs (`cat-transporte`).
- Dates are `YYYY-MM-DD` strings end-to-end; month math in pure logic (`period.ts`, `recurring.ts`),
  never via timezone-prone `Date` arithmetic on day-of-month.
- User-facing strings (descriptions, category names) may be Portuguese; identifiers and comments in English.
