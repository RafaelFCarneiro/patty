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
build it. Reach for remeda before writing a loop.

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

The rule of thumb from `docs/code-style.md` still applies: native `map`/`filter` is fine for
single-stage transforms. Reach for remeda when there are ≥2 stages, grouping, counting, or
predicate composition.

## Avoid unnecessary complexity

Write the simplest code that correctly solves the problem. Do not:

- Add abstraction layers before there are at least three concrete cases.
- Use generics when a concrete type works.
- Add configuration options for behaviour that has never varied.
- Reach for a library when three lines of TypeScript do the job.

The test: if you deleted the abstraction and inlined the logic, would the code be harder to
understand? If not, keep it simple.

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
