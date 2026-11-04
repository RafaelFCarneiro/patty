# Code quality principles

These principles apply to every line of code in a project that adopts them. They are the underlying quality rules
behind every implementation choice; the companion code-style document covers implementation patterns. Examples use a
neutral order-management domain and generic helpers (a `Result` type with `ok`/`err`, a `pipe` helper).

## Constants over literals

Never pass a magic string or number where a named constant exists.

```ts
// ✅ DO
channel: Channel.enum.web
status: OrderStatus.enum.paid

// ❌ DON'T
channel: 'web'
status: 'paid'
```

- An enumeration exposes its members by name — always use them at call sites.
- If a value is used in more than one place, define a constant; do not copy-paste the literal. This covers error
  codes, status strings, numeric thresholds, **and log or error message strings**, even across files.
- **Error payloads are not inline literals either.** Colocate them as named constants or builders on the entity's
  model (`orderErrors.paymentRejected`, `orderErrors.duplicateReference(ref)`) and reference them at the `guard`/`err`
  call. An inline `{ code: 'validation', issues: ['…'] }` in a controller is the same smell as a bare string — it
  scatters domain vocabulary and duplicates messages.

  ```ts
  // ✅ DO
  yield* guard(isPayable(order.status), orderErrors.paymentRejected)

  // ❌ DON'T
  yield* guard(order.status !== OrderStatus.enum.cancelled, { code: 'validation', issues: ['…'] })
  ```

## Naming clarity

Names should make the reader's job effortless. No abbreviations, no acronyms unless universally known (`id`, `url`).

```ts
// ✅ DO
const resolveEffectiveStatus = ...
const guardRefundWindow = ...

// ❌ DON'T
const getStatus = ...
const checkRefund = ...
```

- Functions: verb + noun describing what they do (`createOrder`, `guardShippingRegion`).
- Booleans: `is*`, `has*`, `can*`, `needs*` (`isGift`, `needsReview`).
- Variables: name the domain concept, not the type (`customer`, not `customerResult`).
- File and folder names follow one casing convention, enforced by tooling rather than review.
- A domain with more than one file in a layer gets a folder in that layer, and its files drop the folder's name
  (`logic/billing/plan`, `logic/billing/invoice`, not `logic/billing`, `logic/billing-invoice`).

### Names carry the context of their module — don't repeat it

A function name should not restate the file or namespace it lives in. The call site already provides that context via
the import or namespace prefix.

```ts
// ✅ DO — module is adapters/orders, imported as orderAdapters
export const modelToDb = ...
export const dbToModel = ...

// call site: orderAdapters.modelToDb(entity) — "order" is clear from the prefix

// ❌ DON'T — redundant: the module name already says "orders"
export const modelOrderToDb = ...
export const orderDbToModel = ...
```

When two exports from different modules would collide at a call site, rely on namespacing rather than adding
redundant words to the name:

```ts
// ✅ DO
import * as orderAdapters from './adapters/orders'
import * as customerAdapters from './adapters/customers'
orderAdapters.modelToDb(...)
customerAdapters.modelToDb(...)

// ❌ DON'T — solve the collision by polluting the name
orderModelToDb(...)
customerModelToDb(...)
```

## Single responsibility

One function, one job. If you find yourself writing "and" in a function description, split it.

```ts
// ✅ DO — each function has one reason to change
const resolveCurrency = (customer, order) => ...
const guardRefundWindow = (existing, input) => ...

// ❌ DON'T — resolves AND guards AND derives
const prepareOrderUpdate = (existing, input, deps) => ...
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
if (item.confidence < 0.6)
```

Thresholds, limits, and domain constants belong with the domain model, under a name that encodes intent.

## Declarative over imperative

Prefer expressions that describe *what* the result is over statements that describe *how* to build it. Reach for a
collection/pipeline library before writing a loop.

```ts
// ✅ DO
const counts = countBy(orders, (o) => o.status)
const totals = pipe(lines, groupBy((l) => l.currency), mapValues(sumBy((l) => l.amount)))
const urgent = filter(orders, anyPass([isOverdue, isHighPriority]))

// ❌ DON'T
let counts: Record<string, number> = {}
for (const order of orders) {
  counts[order.status] = (counts[order.status] ?? 0) + 1
}
```

Loops, mutable bindings and in-place accumulation (`push`) are best banned by tooling in the pure layers (logic,
controllers, adapters); the imperative shell and the composition root may use them.

Typical replacements for manual imperative code:

| Instead of… | Use a helper that… |
|---|---|
| a counter incremented in a loop | counts by a key |
| `reduce` building an object | groups, maps values, or sums by a key |
| `a \|\| b \|\| c` over predicates | combines predicates with *any-of* |
| `a && b && c` over predicates | combines predicates with *all-of* |
| chained `.filter().map().sort()` | pipes the stages in one expression |
| `{...a, ...b, ...c}` across many objects | merges a list of objects |
| `list.filter(fn)[0]` or `find(fn) ?? fallback` | picks the first/best match |
| a `switch` that only transforms a value | a conditional or a lookup table |
| `() => fixedValue` | a constant function |

Native `map`/`filter` is fine for single-stage transforms. Reach for the pipeline helper when there are two or more
stages, grouping, counting, or predicate composition.

### Named logic functions over inline lambdas in pipes

Extract inline predicates and mappers into named functions in the logic layer. A pipe should read as a sequence of
*what* happens — named functions provide that; inline lambdas bury the intent.

```ts
// ✅ DO — named functions, the pipe reads declaratively
export const filterByStatus = (status?: OrderStatus) => (o: Order): boolean => !status || o.status === status

return pipe(all, filter(filterByStatus(status)), map(withStatusLabel(locale)))

// ❌ DON'T — inline lambdas obscure intent
return pipe(
  all,
  filter((o) => !status || o.status === status),
  map((o) => withStatusLabel(o, locale)),
)
```

### Helpers that work both standalone and in a pipe

When a custom helper is used both as a plain call and inside pipes, give it both calling conventions (data-first and
data-last) using the pipeline library's own dual-call utility, rather than a hand-rolled curried form that forces an
awkward double call at plain call sites.

```ts
// ✅ DO — one function, two styles
withStatusLabel(order, locale)                          // data-first
pipe(orders, map(withStatusLabel(locale)))              // data-last

// ❌ DON'T — manual currying forces this at every plain call site
withStatusLabel(locale)(order)
```

## Avoid unnecessary complexity

Write the simplest code that correctly solves the problem. Do not:

- Add abstraction layers before there are at least three concrete cases.
- Use generics when a concrete type works.
- Add configuration options for behaviour that has never varied.
- Reach for a library when three lines of code do the job.

The test: if you deleted the abstraction and inlined the logic, would the code be harder to understand? If not, keep
it simple.

## Static imports over inline dynamic imports

Keep imports at the top of the file. A dynamic import scattered through a function body hides a dependency from the
reader (and from tooling).

The one sanctioned exception is a genuine **lazy-load gate**: a module that is expensive or has side effects on load
and is only needed for a runtime-conditional path (a config flag, a CLI subcommand) — not merely "used in one branch
of this function." Even then:

- Isolate the dynamic import inside a single small, named, module-scope function — never inline it as part of a larger
  expression or chain a second `await` off its result.
- Document *why* it is lazy: what it avoids loading, and for which runtime path.
- If more than one call site needs the same lazy module, share the one function — don't repeat the module path.

```ts
// ✅ DO — one named function owns the dynamic import; call sites stay plain
const loadReportEngine = () => import('./report-engine') // heavy; only the "report" subcommand needs it

const maybeRunReport = async (config) => {
  if (!config.reportEnabled) return null
  const { runReport } = await loadReportEngine()
  return runReport(config)
}

// ❌ DON'T — import inline, chained mid-expression, buried in control flow
const report = config.reportEnabled ? await (await import('./report-engine')).runReport(config) : null
```

If there is no genuine runtime-conditional reason, use a static import.

## Function shape

Small functions with one level of branching read at a glance. Bound the shape with limits a linter enforces — a
typical set is about 40 lines per function (blank lines and comments excluded), cyclomatic complexity 10, nesting
depth 3, and 15 statements.

### Exhaustive tables instead of big switches

A `switch` with many cases is a lookup in disguise. Write the table: the key type makes the compiler reject a missing
key, and the lookup is one line.

```ts
// ✅ DO — HTTP status as data; a new error code that is not listed fails the type check
const HTTP_STATUS = { unknown_order: 404, validation: 422 /* … */ } as const satisfies Record<AppError['code'], number>
export const httpStatus = (e: AppError): number => HTTP_STATUS[e.code]

// ✅ DO — each formatter receives its own narrowed error
type Formatters = { [C in AppError['code']]: (e: Extract<AppError, { code: C }>) => string }
const FORMATTERS: Formatters = { unknown_order: (e) => `${e.code}: ${e.id}` /* … */ }

// ❌ DON'T — dozens of `case` labels the compiler only checks through a `never` default
switch (e.code) { case 'unknown_order': case 'unknown_customer': /* … */ return 404 }
```

Split a long table by family (one sub-table per family, spread into the whole) so no literal spans screens.

### The controller sandwich

A controller is three steps, each one a named call: **gather** (reads and I/O through injected dependencies),
**decide** (one pure logic call that returns a plan), **persist** (turn the plan into the effects/response). It should
read in under ten lines; the rules live in the decide step, where they are unit-tested without mocks.

```ts
// ✅ DO — the decision is one pure call; the controller reads, calls it, then returns the outcome
export const updateOrder = (deps: Deps, input: UpdateOrder) =>
  resultFlow(async function* () {
    const existing = yield* loadOwnOrder(deps, input.id)                  // gather
    yield* guardOrderPatch(input)
    const { shipping } = yield* resolveShipping(deps, existing, input)
    const entity = mergePatch(existing, input, shipping)                  // decide (pure)
    return ok(toOutcome(entity))                                          // persist
  })

// ❌ DON'T — reads, rules and write-building interleaved in one body: every `input.x ?? existing.x`,
// the note rule and the classification re-written inline in each aggregate's update
```

Extract by meaning, not by count. A decision that is a function of already-read values moves to the logic layer and
gets unit tests; a read stays in the controller or a named gather helper beside it. Nothing in the logic layer gains
I/O or a dependencies parameter. A helper with eight positional parameters or a `doStep1`/`doStep2` chain is worse than
the function it replaced — pass one facts object and name the concept it computes.

### One named definition per entry point

Each tool or route at the edge is its own named definition (`const createOrderRoute = …`). Its handler only parses,
delegates to the controller and translates the result; the module's job is to export the list.

```ts
// ✅ DO
const createOrderRoute: RouteDefinition = { method: 'post', path: '/orders', handler: handleCreateOrder }
export const orderRoutes = [createOrderRoute, listOrdersRoute]

// ❌ DON'T — a registration function with every handler inlined in its body
export const registerOrderRoutes = (app) => { app.post('/orders', async (req) => { /* 60 lines */ }) /* … */ }
```

A handler that outgrows the limits is orchestration that belongs in a controller (or a shared, named step); a
controller that outgrows them is missing a plan function or a named gather helper — not a reason to disable the rule.

### The shell: a factory binds, queries are named functions

A repository factory has one job: bind the scope and hand each method to a named query. The query bodies sit at module
level over that scope, so a cross-cutting filter (tenancy, soft-delete) is visible in the query and no object literal
grows with the number of methods. An applier is built the same way: a small context, built once, and one named function
per operation.

```ts
// ✅ DO — the factory binds; each query is a named function over the scope
const search = async ({ db, tenantId }: Scope, input: SearchOrders) => { /* … */ }
export const ordersRepo = (db: Db, tenantId: string): OrdersRepo => {
  const scope: Scope = { db, tenantId }
  return { search: (input) => search(scope, input), count: (input) => count(scope, input) }
}

// ❌ DON'T — every query body inside the object the factory returns
export const ordersRepo = (db: Db, tenantId: string): OrdersRepo => ({
  search: async (input) => { /* 20 lines */ },
  aggregate: async (filters) => { /* 25 lines */ },
})
```

Extract by meaning here too: a branchy `insert` becomes `assertKeyMatchesTable`, `rowToInsert`, `conflictTarget` — each
one a decision a reader can name — rather than a `step1`/`step2` split.

## Fail loudly at boundaries, trust internally

- Validate at every external boundary (inbound requests, stored records, external client payloads).
- Inside the domain, trust your own types — do not re-validate data you already decoded.
- Do not add defensive null checks on values the type system guarantees are non-null.

## Consistency over cleverness

When a pattern already exists in the codebase, follow it. Introduce a new pattern only when the existing one genuinely
does not fit, and document the reason. Typical patterns to hold consistently: all name resolution through one set of
helpers; all controller results in one `Result` shape; all boundary adaptation in the adapters layer under one naming
convention; all enumeration members referenced by name, never as string literals.

How a project applies this is that project's own conventions document.
