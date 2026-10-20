# Code quality principles

These principles apply to every line of code written in this repo. They are non-negotiable.
`docs/code-style.md` covers implementation patterns (safeTry, remeda, zod); this document
covers the underlying quality rules that govern all choices.

## Constants over literals

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
  as a bare string — it scatters domain vocabulary and duplicates messages. (See code-style "models/".)

  ```ts
  // ✅ DO
  yield* guard(assertNonCreditType(input.type), accountErrors.creditRejected)

  // ❌ DON'T
  yield* guard(input.type !== AccountType.enum.credit, { code: 'validation', issues: ['…'] })
  ```

## Naming clarity

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

### Names carry the context of their module — don't repeat it

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

## Single responsibility

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

## No magic values

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

## Declarative over imperative

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

The rule of thumb from `docs/code-style.md` still applies: native `map`/`filter` is fine for
single-stage transforms. Reach for remeda when there are ≥2 stages, grouping, counting, or
predicate composition.

### Named logic functions over inline lambdas in pipes

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

### Custom helpers with `purry` (dual data-first / data-last)

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

## Avoid unnecessary complexity

Write the simplest code that correctly solves the problem. Do not:

- Add abstraction layers before there are at least three concrete cases.
- Use generics when a concrete type works.
- Add configuration options for behaviour that has never varied.
- Reach for a library when three lines of TypeScript do the job.

The test: if you deleted the abstraction and inlined the logic, would the code be harder to
understand? If not, keep it simple.

## Static imports over inline dynamic `import()`

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

## Function shape

Small functions with one level of branching read at a glance. The limits below are enforced by lint
(`eslint.config.js`) on all of `src/**` (the switch-size rule is a lint error repo-wide):

| Limit | Value |
|---|---|
| Lines per function (blank lines and comments excluded) | 40 |
| Cyclomatic complexity | 10 |
| Nesting depth | 3 |
| Statements per function | 15 |

### Exhaustive tables instead of big switches

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

### The controller sandwich

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

### One named definition per tool / route

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

### The shell: a factory binds, queries are named functions

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

// ❌ DON'T — every query body inside the object the factory returns (122 lines, one literal)
export const transactionsRepo = (db: Db, userId: string): TransactionsRepo => ({
  search: async (input, refs) => { /* 20 lines */ },
  aggregate: async (filters) => { /* 25 lines */ },
  /* … */
})
```

Extract by meaning here too: a branchy `insert` becomes `assertKeyMatchesTable`, `rowToInsert`, `conflictTarget`,
`persistedIdAfter` — each one a decision a reader can name — rather than a `step1`/`step2` split.

## Fail loudly at boundaries, trust internally

- Validate with zod at every external boundary (HTTP, MCP, DB records). See `docs/code-style.md`.
- Inside the domain, trust your own types — do not re-validate data you already decoded.
- Do not add defensive `if (x == null)` checks on values the type system guarantees are non-null.

## Consistency over cleverness

When a pattern already exists in the codebase, follow it. Introduce a new pattern only when
the existing one genuinely does not fit, and document the reason.

Examples of patterns to follow consistently:
- All name resolution via `controllers/resolve.ts` helpers.
- All result types from controllers as `ResultAsync<T, AppError>`.
- All boundary adaptation in `adapters/` following the `wireInToModel` / `modelToWireOut` convention.
- All enum values referenced via `.enum.*`, never as string literals.
