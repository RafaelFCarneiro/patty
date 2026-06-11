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
- Name resolution: ALWAYS via `controllers/resolve.ts` (`resolveAccountRef`, `resolveCategoryRef`,
  `resolveCardRef`) — never inline `resolveByName` + error mapping in a controller.
- Expected failures are `AppError` values; unexpected errors throw (become 500s). Never `try/catch`
  business outcomes; never throw domain errors.

## logic/ — pure and declarative

- No I/O, no `Date.now()`/`new Date()` (clock comes from deps), no imports from `controllers/` or `diplomat/`.
- Data transformation with **remeda** when ≥2 stages or grouping is involved (ADR-003):

```ts
// ✅ DO
export const summarize = (rows: readonly SummaryRow[]) =>
  R.pipe(rows, R.groupBy((r) => r.currency), R.entries(), R.map(toCurrencySummary), R.sortBy((s) => s.currency))

// ❌ DON'T
const currencies = [...new Set(rows.map((r) => r.currency))].sort()
return currencies.map((currency) => { const mine = rows.filter(...); ... })  // manual grouping
```

- Native `map`/`filter` is fine for single-stage transforms. Don't force pipes onto control flow.
- Every logic function gets a colocated `*.test.ts` (vitest) — pure functions, no mocks.

## models/ — zod single source of truth

- Types are ALWAYS `z.infer<typeof Schema>` — never hand-written interfaces for domain data.
- Distinguish input schemas (`CreateTransactionInput` — names, optional fields) from entity
  schemas (`Transaction` — ids, resolved). Inputs use `MovementType`; only entities carry
  `TransactionType` (which includes `'transfer'`).

## diplomat/ — thin, no business logic

- http/mcp handlers: zod-parse → call controller → translate Result. Nothing else.
- db: parameterized Cypher ONLY — interpolating user input into a query string is a security bug.
  Decode every record through `adapters/` zod parsing. Aggregations that could multiply rows use
  sequential `WITH` aggregation (see `balanceParts`).
- New MCP tools: rich `description` (the agent reads it!), `.describe()` on non-obvious fields,
  documented in `docs/mcp-tools.md` in the same change.

## Naming & misc

- Files: camelCase matching the domain (`creditCards.ts`); tests colocated (`bill.test.ts`).
- IDs `crypto.randomUUID()` via `deps.newId()`; seeds use stable slugs (`cat-transporte`).
- Dates are `YYYY-MM-DD` strings end-to-end; month math in pure logic (`period.ts`, `recurring.ts`),
  never via timezone-prone `Date` arithmetic on day-of-month.
- User-facing strings (descriptions, category names) may be Portuguese; identifiers and comments in English.
