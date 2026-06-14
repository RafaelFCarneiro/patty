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
