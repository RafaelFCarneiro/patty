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

Thresholds, limits, and domain constants belong in `models/` or `logic/` with a name that
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
