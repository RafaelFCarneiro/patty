# ADR-012: Per-model error definitions; `common` composes the `AppError` union

**Status:** Accepted · **Date:** 2026-06-26 · **Deciders:** Rafael · Builds on the error-payload
colocation introduced in `refactor/account`. Major, mostly-mechanical change touching every model and
the error plumbing — recorded here before the diff.

## Context

Expected domain failures are modeled as `AppError` and returned on the neverthrow track (ADR-001).
Today `common/errors.ts` owns this as a **single flat union of every entity's errors**, plus two
exhaustive switches over it (`formatAppError`, `httpStatus`):

```ts
// common/errors.ts (as built)
export type AppError =
  | { code: 'unknown_account'; ... }
  | { code: 'duplicate_name'; entity: 'account' | 'category' | ...; name: string }
  | { code: 'in_use'; entity: 'account'; references: {...} }
  | { code: 'category_kind_mismatch'; ... }
  | { code: 'validation'; issues: string[] }
  // …every entity's failures, in one place
```

`refactor/account` started colocating expected-error **payloads** with the entity they describe
(`accountErrors.creditRejected`, `accountErrors.duplicateName(name)`, `accountErrors.inUse(...)` on
`models/account.ts`). That is the right direction — error payloads are domain vocabulary — but to *type*
them the model must import the global `AppError` (currently a **type-only** import, allowed as a documented
exception). So an account model transitively depends on a union that also enumerates category, transaction,
card, and bill failures. The dependency points the wrong way: a single entity should not have to know about
every sibling entity's errors to declare its own.

Two forces are in tension:

- **Domain cohesion / dependency direction.** Each entity should own its vocabulary (schema, descriptions,
  defaults, *and* error payloads) without depending on a god-union. `common/` should hold genuinely shared
  primitives, not become the bridge where every concern lands and ownership is lost.
- **Centralized boundary mapping.** `formatAppError` and `httpStatus` are exhaustive switches that benefit
  from seeing the *whole* set of errors in one place (the compiler enforces totality). Fragmenting them
  has a cost.

## Decision

**Invert ownership: each model defines its own error union as domain vocabulary; `common/errors.ts`
*composes* `AppError` from those per-model unions and keeps the boundary mapping.** `common` depends on
`models`, not the reverse.

```ts
// models/account.ts — owns its errors + payload builders
export type AccountError =
  | DuplicateName<'account'>
  | InUse<'account', AccountReferences>
  | ValidationError
export const accountErrors = { /* builders, as today */ }

// models/category.ts, models/transaction.ts, … — same shape per entity

// common/errors.ts — composition only (depends on models)
export type AppError = AccountError | CategoryError | TransactionError | CardError | BillError
export const formatAppError = (e: AppError): string => { /* switch over composed union */ }
export const httpStatus    = (e: AppError): number => { /* switch over composed union */ }
```

Shared **error primitives** that several entities reuse (`ValidationError = { code:'validation'; issues }`,
and generic shapes like `DuplicateName<E>`, `InUse<E,R>`, `NotFound<E>`) live in a small shared module
(e.g. `common/errors/primitives.ts` or `models/error.ts`) that models import — these are vocabulary, not a
catch-all. The dependency table changes so `models/` may import the shared error *primitives*, and `models/`
no longer imports the composed `AppError`.

## Options Considered

### Option A: Status quo — one flat `AppError` in `common/` (rejected)
| Dimension | Assessment |
|---|---|
| Complexity | Low (nothing changes) |
| Dependency direction | **Backwards** — models depend on a union of all siblings' errors |
| `common/` bloat | Grows with every entity; the bridge problem persists |
| Boundary mapping | Centralized (the one upside) |

**Pros:** zero work; exhaustive switches trivially see everything.
**Cons:** the coupling and `common/`-as-dumping-ground smell this ADR exists to fix.

### Option B: Per-model unions + `common` composes the union (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium (mechanical migration; one-time) |
| Dependency direction | Correct — `common → models`; entities own their errors |
| `common/` role | Reduced to composition + shared primitives + boundary mapping |
| Boundary mapping | Still centralized over the composed union (totality preserved) |

**Pros:** entity + schema + descriptions + defaults + errors live together; adding an entity never edits a
god-union; `common` stops accreting domain knowledge; the two switches stay exhaustive over the composed type.
**Cons:** a shared-primitives module is needed; one large mechanical PR; contributors learn where the union is assembled.

### Option C: Per-model unions + per-model formatters/status (fully distributed) (deferred)
| Dimension | Assessment |
|---|---|
| Complexity | High — each model owns its `format`/`httpStatus` slice; `common` dispatches |
| Dependency direction | Correct |
| Boundary mapping | Distributed — no single exhaustive switch; totality harder to enforce |

**Pros:** maximal cohesion; HTTP/format mapping travels with the error.
**Cons:** loses the single exhaustive switch (the compiler no longer catches an unmapped code in one spot);
more indirection than the small, fixed error surface warrants. Revisit only if the central switches bloat.

## Trade-off Analysis

The real tension is **dependency direction/cohesion vs. centralized exhaustiveness**. Option A keeps the
switches simplest but cements the backwards dependency and the `common` bridge. Option C maximizes cohesion
but sacrifices the single exhaustive mapping that makes "did we handle every error at the HTTP boundary?" a
compile-time guarantee. **Option B is the middle that keeps both wins that matter**: entities own their
vocabulary (so `common` stops being a catch-all and the dependency points `common → models`), while the
boundary mapping stays centralized and total over the composed union. The cost — a shared-primitives module
and a one-time mechanical sweep — is bounded and paid once.

## Consequences

- **Easier:** a model change ships its schema, descriptions, defaults, and errors together; adding an entity
  doesn't touch a shared union; `common/` shrinks to composition + shared primitives + Result combinators.
- **Harder / to revisit:** need a shared error-primitives module (and a convention for what is "shared"
  vs. entity-specific); the migration touches every model and `errors.ts` at once; contributors must know the
  union is assembled in `common`.
- **Dependency table** (`docs/architecture.md`) changes: `models/` may import shared error *primitives*;
  `models/` no longer imports the composed `AppError`; `common/errors` depends on `models/`. The current
  type-only-import exception (added in `refactor/account`) is **superseded** by this once implemented.
- **Boundary mapping stays centralized.** `formatAppError` / `httpStatus` remain single exhaustive switches
  over the composed `AppError` — no behavior change at the HTTP/MCP edges.
- **Do it in one sweep**, behind the full gate (`lint && typecheck && test:all && build`); a half-migrated
  state (some models own errors, some don't) is worse than either end state.

## Action Items

1. [ ] Define shared error primitives (`ValidationError`, generic `DuplicateName<E>`, `InUse<E,R>`,
   `NotFound<E>` / `Ambiguous<E>`) in one small module models may import.
2. [ ] Per entity: define `XxxError` union on its model and move/keep the payload builders there.
3. [ ] `common/errors.ts`: `AppError = ⋃ XxxError`; keep `formatAppError` / `httpStatus` exhaustive over it.
4. [ ] Update `docs/architecture.md` dependency table (models → error primitives; `common/errors` → models;
   remove the type-only `AppError`-in-models exception) and add this ADR to the index on acceptance.
5. [ ] Verify the gate stays green and the HTTP status / format outputs are unchanged (snapshot the switches).
