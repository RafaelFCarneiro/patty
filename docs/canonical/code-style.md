# Code style & generation guidelines

Rules with do/don't examples for code written in a layered, functional-style service. Examples use a neutral
order-management domain and generic helpers (a `Result` type with `ok`/`err`, a `guard` and an `okOr` combinator, a
`pipe` helper); a project substitutes its own libraries.

## General

- Strict typing. `const` + expressions over `let` + mutation. Arrow functions. No classes in the domain (the only
  acceptable class usage is library-provided).
- Prefer small named functions over inline complexity; extract when a function does two things.
- Comments explain *why* (invariants, trade-offs), never *what* the code already says. A rule the code cannot show (a
  guarantee a port makes, a race a write closes) is pinned by a test with a descriptive name, not only by a comment — a
  comment can rot, a failing test cannot.

## Controllers — Result composition (Railway-Oriented)

Controllers return a `Result` (or async `Result`) for **expected** failures and compose with a generator-based
generator-based result-composition helper. Each `yield*` short-circuits on the error track. Never write resolve-then-early-return chains.

```ts
// ✅ DO
export const getOrderSummary = (deps: Deps, input: GetOrderSummary): AsyncResult<OrderSummary, AppError> =>
  resultFlow(async function* () {
    const customer = yield* resolveCustomerRef(deps, input.customer)
    const order = yield* okOr(await deps.orders.get(customer.id, input.reference), {
      code: 'unknown_order', customer: customer.name, reference: input.reference,
    })
    return ok(summarizeOrder(order))
  })

// ❌ DON'T
export const getOrderSummary = async (deps, input) => {
  let customerId: string | null = null        // let + mutation
  const res = resolveByName(...)              // duplicated resolution boilerplate
  if (res.kind === 'none') return err(...)    // early-return chains
  ...
}
```

- Preconditions: `yield* guard(cond, error)`. Nullables: `yield* okOr(value, error)`. Both arguments are named, not
  inline: the **condition** is a predicate (pure → the logic layer; touching a repository → a small async controller
  helper) and the **error** is a colocated model payload. Don't bury the rule in an inline boolean or hand-roll the
  `{ code, … }` literal:

  ```ts
  // ✅ DO — condition + payload each have a home
  yield* guard(isPayable(input.status), orderErrors.paymentRejected)                          // pure predicate
  yield* guard(await isReferenceAvailable(deps, input.reference), orderErrors.duplicateReference(input.reference))

  // ❌ DON'T — inline condition + inline error literal
  yield* guard(input.status !== OrderStatus.enum.cancelled, { code: 'validation', issues: ['…'] })
  ```
- Controllers work with **models only**: hand repositories domain drafts; never build flat storage properties and never
  import adapters — model→storage flattening lives in the infrastructure layer via adapters.
- All boundary adaptation lives outside controllers: the edge adapts wire-in → model before the controller call and
  model → wire-out after it. Repositories may use adapters internally for model ↔ storage.
- Name resolution always goes through shared resolvers (`resolveCustomerRef`, `resolveProductRef`) — never inline a
  lookup-by-name plus error mapping in a controller.
- Expected failures are error *values*; unexpected errors throw (and become server errors). Never `try/catch`
  business outcomes; never throw domain errors.
- When resolving independent async dependencies, pipe the combined `Promise.all` result for an expression body:

```ts
// ✅ DO
export const getStatus = async (deps: Deps): Promise<Status> =>
  pipe(
    await Promise.all([deps.health.reachable(), deps.locale()]),
    ([reachable, locale]) => ({ db: reachable ? 'ok' : 'error' as const, locale }),
  )

// ❌ DON'T
export const getStatus = async (deps: Deps): Promise<Status> => {
  const [reachable, locale] = await Promise.all([...])
  return { db: reachable ? 'ok' : 'error', locale }
}
```

### Write-path controllers — return effects, don't perform them

The core of a flow decides; the shell executes. A controller still composes with the Result helpers exactly as above —
only the last step changes: instead of `await`ing a repository write and returning the written row, it builds the write
as a typed, entity-tagged effect and returns it alongside the response, for the shell's generic engine to apply. The
principle is documented in the functional-core / imperative-shell document; read it before touching a write flow.

```ts
// ✅ DO — the core decides and returns the write as data; it never calls a repository write method
export const createOrder = (deps: Deps, input: CreateOrder): AsyncResult<FlowOutcome<Order>, AppError> =>
  resultFlow(async function* () {
    yield* guard(isPayable(input.status), orderErrors.paymentRejected)
    yield* guard(await isReferenceAvailable(deps, input.reference), orderErrors.duplicateReference(input.reference))

    const order: Order = { id: deps.newId(), ...input }          // a new row's version is the shell's constant
    const effects = [effect.insert({ entity: ORDER_ENTITY_TAG, model: order })]
    return ok({ effects, response: order })
  })

// the edge handler adapts model → stored row explicitly, once, before the engine sees the batch
const flow = () => createOrder(deps, orderAdapters.createWireInToModel(args)).map(orderAdapters.outcomeToDb)
return fromResult(await runEffects(flow))

// ❌ DON'T — the core performing its own write
export const createOrder = (deps: Deps, input: CreateOrder): AsyncResult<Order, AppError> =>
  resultFlow(async function* () {
    yield* guard(isPayable(input.status), orderErrors.paymentRejected)
    return ok(await deps.orders.create({ id: deps.newId(), ...input }))
  })
```

- Build effects through shared builders (`insert`/`update`/`remove`), one place that constructs the tagged shape,
  instead of hand-writing an `{ op, entity, model }` literal at each call site. The builders are generic over the
  entity's tag and model, so they never need a new case as more flows convert. The write intent (`op`) is a named enum,
  not a bare string.
- **The entity tag is owned by the entity's own model**, not by the engine: a shared enum of all entities would be
  magic-value coupling.
- An `insert` effect's model is the plain domain model — **no version**. A brand-new row's version is always the same
  structural constant, so it never appears in what the core builds. `update`/`delete` are different: the version is
  the value the core actually read, so it is real data the model carries.
- **Model → stored-row adaptation happens once, explicitly, at the edge handler — never inside the shell's engine.**
  By the time the engine or an entity's applier sees an effect, its model is already a row; the applier only writes it.
- **Appliers are registered, never branched on.** An entity's applier lives beside its other persistence code and is
  registered once at the composition root; nothing special-cases an entity tag around the engine.
- **Don't hand-write an applier for a table that already fits the shared id/version convention** — reuse the generic
  one. A table with a secondary unique column still reuses it for update/delete and wraps only `insert` to translate
  the unique-violation race into a version conflict. Hand-write an applier only for a table that does not fit the
  convention at all (for example a key-only link table).
- Composition (a flow that orchestrates another controller) **merges** effect arrays — take the called controller's
  effects, add your own, return the merged batch; don't apply either separately.
- A converted controller's dependencies still expose reads — the purity boundary is writes, not all I/O.

### Controller shape — gather, decide, persist

A controller reads in three named steps: **gather** (resolve refs, repository reads through dependencies), **decide**
(one pure call from the gathered values to an entity, guards and data), **persist** (build the effects and response).
Rules belong in the decide step, where they are unit-tested without mocks.

```ts
// ✅ DO — gather in the controller, the decision is a pure plan call, then persist
const shipping = yield* resolveShipping(deps, input, region)                      // gather
const plan = planNewOrder({                                                       // decide (pure)
  id: deps.newId(), today: toIsoDate(deps.clock()), input, region, shipping,
  candidates: await matchCandidatesFor(deps, input.description),
})
const effects = [effect.insert({ entity: ORDER_ENTITY_TAG, model: plan.entity, idempotencyKey: plan.idempotencyKey })]

// ❌ DON'T — default status, classification, entity literal and key derivation written inline in the controller
const status = input.status ?? defaultStatusFor(date, today)
const entity: Order = { id: deps.newId(), /* … 15 fields … */ }
```

## Logic — pure and declarative

- No I/O, no wall-clock reads (the clock comes from dependencies), no imports from controllers or the edge.
- Transform data with a pipeline library when two or more stages or grouping are involved:

```ts
// ✅ DO
export const summarize = (rows: readonly Row[]) =>
  pipe(rows, groupBy((r) => r.currency), entries(), map(toCurrencySummary), sortBy((s) => s.currency))

// ❌ DON'T
const currencies = [...new Set(rows.map((r) => r.currency))].sort()
return currencies.map((currency) => { const mine = rows.filter(...); ... })  // manual grouping
```

- Native `map`/`filter` is fine for single-stage transforms.
- **Guard conditions belong here when pure.** Extract a reusable boolean precondition into a named predicate
  (`isPayable(status)`) instead of inlining `x !== Enum.value` at the `guard` call. Predicates are trivially
  unit-tested and reused across create/update/delete. (Repository-dependent conditions can't be pure — keep those as
  small async helpers in the controller.)
- Every logic function gets a mirrored unit test — pure functions, no mocks.

## Testing requirements

- Behavior changes ship unit tests in the same change.
- New logic functions ship with a matching test; controller, repository and adapter changes add or update focused
  tests covering success **and** expected-failure paths.
- Prefer small, deterministic tests; avoid network or database side effects in unit tests.

## Models — schema as single source of truth

- **Every type and constant lives with the models** — plan/facts shapes, extracted unions, sentinels, key prefixes.
  Controllers and logic hold functions only; a type a function needs is imported, never declared beside it. Plan/facts
  types are hand-written (they are not domain data); domain data stays inferred from its schema. The exceptions are
  shapes that cannot live there: ports naming infrastructure types, and function-valued dispatch tables.
- Types are always inferred from the schema — never hand-written interfaces for domain data.
- **Naming: the schema value gets the `Schema` suffix; the inferred type gets the bare name.**
  `export const OrderSchema = schema.object({...})` + `export type Order = Infer<typeof OrderSchema>`. Derived schemas
  keep the suffix (`CreateOrderSchema`) with bare-name types (`CreateOrder`). This removes the value-vs-type
  ambiguity at import sites.
- Distinguish input schemas (`CreateOrderInput` — names, optional fields) from entity schemas (`Order` — ids,
  resolved). Inputs use a narrow movement/kind enum; only entities carry the wider one.
- **A shared core schema composes UP (extend), never carries the union for aggregates to carve DOWN (omit).** A field,
  rule or error belongs on the shared core only if the shared read/persistence side is genuinely defined over it;
  anything a single aggregate introduces is defined in that aggregate's own model and layered onto the core:

  ```ts
  // core — minimal, shared vocabulary only
  export const CreateLineSchema = schema.object({ description, amount, date })

  // the order aggregate composes UP: adds order-only fields the core never carries
  export const AddOrderLineSchema = CreateLineSchema.extend({ order, coupon }).strict()

  // ❌ DON'T — the core names `order` and `coupon` so every other aggregate must `.omit` them away
  ```

  Field-tied errors move with their field to the aggregate that owns it. The one carve-out: a read/summary concern
  that is *structurally* defined over a value common to every aggregate stays on the core even though a single
  aggregate owns the policy around it — the test is "does the shared read/persistence side need this," not "does only
  one caller set it."
- **Descriptions are domain info — put them on the model field**, not re-authored at the edge. The edge derives its
  schema from the model so the same text surfaces.
- **Defaults by intent:** integrity defaults (a value that must exist for validity, such as `quantity` defaulting to
  `1`) go on the **domain** schema; not-null fields stay **required** in the model. Quality-of-life defaults
  (convenience when omitted, such as a currency) go on the **wire** schema via extend — never weaken the domain
  contract for caller convenience.
- **Expected-error payloads live with the entity.** Each model defines its own error union typed against shared
  primitives and colocates payload builders. Models never import the composed application-wide error type:

  ```ts
  // order model
  export type OrderError = DuplicateName<'order'> | ValidationError

  export const orderErrors = {
    paymentRejected: { code: 'validation', issues: ['…use the payment flow…'] } satisfies OrderError,
    duplicateReference: (ref: string): OrderError => ({ code: 'duplicate_name', entity: 'order', name: ref }),
  }
  ```

  Controllers raise them; they never inline the `{ code, … }` literal.

## Edge (inbound/outbound) — thin, no business logic

- Handlers: parse the wire input → adapt to model → call controller → adapt model to wire output → translate the
  Result. Nothing else.
- Storage: parameterized queries only — never string-interpolate user input (a security bug). Decode every row through
  the storage wire schema and adapters.
- Edge and shell expected failures follow the same Result convention as controllers: a plain discriminated error value
  (`{ code, … }`), never a thrown error subclass. A throwing third-party API (filesystem, credential store, readline) is
  wrapped exactly once, at the adapter; only unexpected failures throw.
- One named definition per route and per tool; the module exports the list and registration is generic. A handler is
  decode → delegate → map, about ten lines:

  ```ts
  // ✅ DO — metadata is data, the handler uses shared helpers
  const deleteOrderRoute: RouteDefinition = {
    method: 'delete', path: '/orders/:id', summary: 'Delete order',
    handler: async (req, reply, scope) => {
      const { deps, runEffects } = scope()
      const flow = () => deleteOrder(deps, pathParam(req, 'id')).map(orderAdapters.outcomeToDb)
      return send(reply, await runEffects(flow))
    },
  }
  export const orderRoutes = [listOrdersRoute, createOrderRoute, deleteOrderRoute]

  // ❌ DON'T — an inline status-code literal, a bare name, a registration function wrapping every handler
  if (!parsed.success) return reply.status(VALIDATION_STATUS).send({ error: { code: 'validation', issues: ['…'] } })
  ```

- Agent-facing tool definitions carry a rich description (the agent reads it) and a description on every non-obvious
  field, documented in the same change.

## Schema validation requirements

- Every external boundary validates with a schema before entering the domain (inbound requests, stored records,
  external client and resource payloads).
- Use the safe-parse form when returning expected validation errors on the Result track; use the throwing form only
  when a throw-on-invalid boundary is intentional and handled at the edge.
- Never pass unvalidated unknown data to controllers, logic, or models.

## Adapters and wire

- Adapters are pure translators for boundary directions: `wireInToModel`, `modelToWireOut`, `modelToDb`, `dbToModel`.
- Use namespace imports for clarity at call sites (`orderAdapters.modelToDb(...)`).
- Wire contracts live in their own boundary module (inbound, outbound, storage); do not place them with the models.

## Naming & misc

- File and folder names match the domain and follow one casing convention; tests mirror the source layout and are not
  colocated with it, so the test runner's configured folders always pick them up.
- Identifiers come from an injected generator and seeds use stable slugs, so tests and seeds are deterministic.
- Dates are plain ISO date strings end-to-end; month math lives in pure logic, never in timezone-prone date arithmetic
  on day-of-month.
- Identifiers and comments are in one language; user-facing strings follow the product's locale.

How a project applies this is that project's own conventions document.
