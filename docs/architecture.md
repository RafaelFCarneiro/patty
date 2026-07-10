# FinTrack v2 — Architecture (as built)

> **This file describes the system as it IS.** Update it in the same change that alters architecture.
> Roadmap and vision: `docs/PLAN.md`. Decisions + rationale: `docs/adr/`. Agent instructions: `CLAUDE.md`.

## Stack

TypeScript (ESM, Node 22) · Fastify 5 · zod · neverthrow · remeda · libSQL (encrypted, local-first) · Drizzle ORM.
Surfaces: **MCP (primary)** at `POST /mcp` (streamable HTTP, stateless) and REST at `/api`.

## Diplomat layers

```
diplomat/http (Fastify)   diplomat/mcp (tools)        ← thin edges: parse, delegate, translate
            └────────┬────────┘
              controllers/                            ← effect composition: safeTry pipelines,
            (ResultAsync<T, AppError>)                  shared resolvers (resolve.ts)
        ┌────────────┼────────────┐
   logic/ (pure)  adapters/   diplomat/db (SQL/Drizzle) ← logic: no I/O ever; db: parameterized only
            models/ (zod = single source of truth)
```

FP stack (ADR-001, ADR-003): zod = schemas/decoding · neverthrow = fallible control flow (`safeTry` + `guard`/`okOr`) · remeda = data reshaping in logic/adapters. One concern per library.

## Diplomat alignment in this project

This section records how FinTrack applies Diplomat core concepts in the current codebase.
If any generic concept is ambiguous, this file is the source of truth for implementation choices.

1. Schema stack: zod is the schema system used for models and boundary decoding.
2. Controller dependency style: controllers orchestrate through injected deps interfaces (`controllers/deps.ts`) and must not import `diplomat/` modules directly. **Documented exception**: `import type` of repo contracts from `diplomat/db/repos` is allowed (type-only imports erase at runtime; the contracts live next to their implementations until a dedicated ports module is warranted).
3. Diplomat role: `diplomat/http` and `diplomat/mcp` remain thin edges (parse/delegate/translate), while side effects are composed in controllers via deps. **FinTrack restriction**: unlike the generic Diplomat pattern, controllers here must NOT import `diplomat/` modules — they interact exclusively through injected deps interfaces (`controllers/deps.ts`). The generic dependency table in `docs/diplomatic-architecture.md` lists `diplomat.*` as a valid controller dependency; that does not apply here.
4. Adaptation boundaries: adapters are pure translators for all boundary crossings, not only db. They convert `wire/in -> model`, `model -> wire/out`, and `model <-> wire/db`.
5. Persistence adaptation: controllers hand repos **domain drafts** (models — e.g. `TransactionDraft` with nested `classification`); `diplomat/db` may use adapters internally to flatten model→db and decode db→model. Controllers never build db-wire shapes and never call adapters.
6. Edge flow contract: `diplomat/http`, `diplomat/mcp`, and other diplomats adapt external payloads with wire schemas + adapters before calling controllers, then adapt controller results back to wire/out.

### Dependency direction (enforced)

| Namespace | Can depend on |
| --- | --- |
| `controllers/` | `logic/`, `models/`, `common/`, injected deps interfaces |
| `logic/` | `logic/`, `models/` only |
| `models/` | zod/schema helpers, `models/error.ts` (shared error primitives). Each model defines its own error union and payload builders (ADR-012); models never import the composed `AppError`. |
| `models/creditCard.ts` | Same base `models/` rule, **plus** it may depend on `models/transaction.ts` (ADR-016: the aggregate model may depend on the core model, never the reverse) — `AddCardPurchaseSchema` is credit-card domain vocabulary (its very shape and reason to exist are card-purchase-specific), so it's defined here, not in `models/transaction.ts`, even though it's derived from `CreateTransactionSchema`. Same for `cardErrors.paidBillImmutable`/`cardErrors.accountChangeRejectedForCard`: both are raised exclusively by the credit-card aggregate (`controllers/creditCard/transaction.ts`), never the core, so their payloads live here too — contrast `transactionErrors.billAssignmentRequiresCard` (`models/transaction.ts`), which the core itself also raises (`transaction/{core,bulk}.ts`) and so must stay on the core model, not move here. This mirrors the controller-layer arrow at the schema/error-vocabulary layer: hosting an aggregate-exclusive schema or error inside the "core" model file would be the same bounded-context leak the ADR exists to prevent, even without a literal import cycle — the test is not "is this ValidationError-shaped" (both sides are) but "who is the only caller." |
| `models/account.ts` | Same base `models/` rule, **plus** it may depend on `models/transaction.ts` (ADR-016 step 3: same aggregate-may-depend-on-core rule as `models/creditCard.ts` above) — `AddAccountMovementSchema` is account-movement vocabulary (it's derived from `CreateTransactionSchema` minus the card/bill fields that don't apply to an account movement), so it's defined here, not in `models/transaction.ts`. `accountErrors.creditPostRejected` (raised only by the account aggregate, `controllers/account/transaction.ts`) already lived here before this split, consistent with the same rule. `CreateTransferSchema` moved here at ADR-016 step 4 (from `models/transaction.ts`, which never had a `createTransfer` entry point of its own) for the same reason: a transfer request is account-context vocabulary, even though `transfer.ts` persists it via the core's `TransactionType.enum.transfer` row shape. |
| `common/errors` | `models/` (composes `AppError` as the union of per-model error types; ADR-012) |
| `adapters/` | `models/`, `wire/*` |
| `diplomat/*` | `controllers/`, `adapters/`, `models/`, wire schemas, runtime clients |
| `diplomat/db/seed/` | `models/` (types and runtime enums) — nothing outside `diplomat/db` imports `seed/` |
| `diplomat/mcp` → `diplomat/http/{routes,openapi}.ts` | **Documented exception**: `buildRouteDefinitions`/`buildOpenApiDocument` are deterministic, no-business-logic wire-schema-driven builders (their only module-scope effect is a one-time, idempotent `extendZodWithOpenApi(z)` zod-prototype patch) reused verbatim by both the REST route and the `fintrack://openapi` MCP resource — including under stdio transport, which never touches Fastify — so the two surfaces can't drift (ADR-013 Phase A). |
| `controllers/transaction/{core,read,bulk}.ts` | **Narrower than `controllers/` above (ADR-016)**: same base rule, but additionally must NOT import `logic/bill.js`, `deps.bills`, or anything from `controllers/creditCard/*`/`controllers/account/*`/`models/creditCard.ts`/`models/account.ts` — not even a type-only import (enforced: `rg "logic/bill\|deps\.bills" src/controllers/transaction/` and `rg "creditCard|controllers/account" src/controllers/transaction/ src/models/transaction.ts` each match only the header comments that document this rule — no actual import or usage) — this is the shared transaction core (row integrity, category resolution, generic patch/delete primitives, bulk-import defaulting, cross-cutting reads) that aggregates depend on, never the reverse. `bulk.ts`'s `createTransactionsBulk` does **not** decide which aggregate owns a line itself — that decision (exclusivity, bill-assignment guards, account-vs-card dispatch) lives in exactly one place, `diplomat/transactionRouting.ts`'s private `routeTransactionLine` (ADR-016 step 4: the god `create_transaction` tool/route this dispatch once backed directly is retired; the decision survives only to serve bulk). `bulk.ts` only defaults per-line fields (date, account/card top-level fallback, idempotencyKey) and calls the injected `RouteTransactionLineFn` callback — typed purely against the core's own `CreateTransaction`/`CreateTransactionResult`, with no card- or account-shaped field baked into the signature — once per line. This also means the routing guards (`assertExclusiveAccountCard`, `assertBillPeriodPaired`, `assertBillAssignmentHasCard`) are asserted only inside `routeTransactionLine`, not duplicated in `bulk.ts` — a duplication a prior revision of this step introduced and then removed. |
| `controllers/creditCard/*` | Same base `controllers/` rule, **plus** it may depend on `controllers/transaction/{core,read}.ts` (never `bulk.ts`'s bulk-routing internals) — the credit-card aggregate owns card CRUD (`creditCard.ts`), the bill lifecycle (`bill.ts`), and card-transaction policy (`transaction.ts`: `addCardPurchase`/`updateCardTransaction`/`deleteCardTransaction`), validating (paid-bill immutability, cycle resolution) before delegating row persistence to the core. |
| `controllers/account/*` | Same base `controllers/` rule, **plus** it may depend on `controllers/transaction/{core,read}.ts` (never `bulk.ts`'s bulk-routing internals) — the account aggregate owns account CRUD + balances (`account.ts`), account-movement policy (`transaction.ts`: `addAccountExpense`/`addAccountIncome` — namespaced as `controllers/account/*` already, so the file doesn't repeat "account" in its own name), and transfers (`transfer.ts`: `createTransfer`, folded in from the former top-level `controllers/transfers.ts` at ADR-016 step 4 — a transfer request is account-context vocabulary even though it persists via the shared core primitive), validating (non-credit account, category/sub-category exclusivity, currency match, distinct legs) before delegating row persistence to the core. |
| `diplomat/transactionRouting.ts` | Same base `diplomat/*` rule. Composition-root dispatch shared by `diplomat/mcp` and `diplomat/http`: decides, per update/delete request or `create_transactions_bulk` line, whether the transaction core, the credit-card aggregate, or the account aggregate owns it, so both surfaces route identically instead of duplicating the decision. Delegation only — no domain policy lives here. |

### Boundary schemas and adapter naming

- External shapes belong to `src/wire/`, split by intent:
  - `wire/in`: inbound contracts from clients/resources (request payloads, tool args, events).
  - `wire/out`: outbound contracts exposed by this service (responses, published payloads).
  - `wire/db`: storage-facing contracts (db rows/records/properties).
- Domain layer (`controllers/`, `logic/`, `models/`) stays agnostic to wire schemas and infrastructure tools.

#### Domain ownership: descriptions, defaults, and error payloads

These three live with the domain entity in `models/`, not scattered across controllers/diplomats:

- **Descriptions are domain information.** `.describe()` states what a field *is and represents*, so it belongs on the domain schema in `models/`. The MCP/REST edge surfaces those same descriptions by deriving its input schema from the model (`Schema.shape`) instead of re-authoring prose.
- **Defaults split by intent.** A default that protects an **invariant** — a value that must exist for the entity to be valid ("would break if missing", e.g. `initialBalance → 0`) — lives on the **domain** schema. A **quality-of-life** default (a convenience when the caller omits an otherwise-required field, e.g. "no currency given → assume USD") lives at the **wire boundary** (`wire/in`, derived via `.extend`). The domain stays honest about what is genuinely required; not-null fields stay required in the model.
- **Expected-error payloads are domain vocabulary (ADR-012).** Each model defines its own error union (e.g. `AccountError`, `CategoryError`) and payload builders (e.g. `accountErrors.duplicateName(name)`), typed against shared primitives from `models/error.ts` — never against the composed `AppError`. `common/errors.ts` composes `AppError` as the union of all per-model error types and keeps the exhaustive `formatAppError`/`httpStatus` switches. Controllers *raise* errors via builders (`guard(condition, accountErrors.X)`) but never author the `{ code, … }` literal inline.
- **Guard conditions are named predicates, not inline boolean soup.** A pure condition is a predicate in `logic/` (e.g. `assertNonCreditType(type)`, `isUnreferenced(refs)`); a condition that needs a repo is a small async predicate in the controller (e.g. `assertNameAvailable(deps, name)`). The `guard` then reads as `guard(predicate(...), errorPayload)` — condition and payload each have a single home. Inline comparisons like `refs.transactions === 0` are the same smell as an inline error literal — extract them.
- **The shapes a decision is made from are domain types too.** When the domain decides whether to allow/block an operation based on some derived shape (e.g. `AccountReferences` = what counts as a blocking reference to an account), that shape is a `models/` type; the repo *populates* it and `logic/` predicates *interpret* it. The model — not the repo — declares what counts.
- Adapter functions should be grouped per domain and named by direction, for example:
  - `wireInToModel`
  - `modelToWireOut`
  - `modelToDb`
  - `dbToModel`
- In call sites, prefer namespace imports for clarity, e.g. `import * as transactionAdapters from '../adapters/transactions.js'` then `transactionAdapters.modelToDb(...)`.

## Relational schema (as built)

Database: encrypted libSQL file (`fintrack.db`) opened via `@libsql/client` (async) with `drizzle-orm/libsql`. Schema defined in `src/diplomat/db/schema.ts`; migrations generated by `drizzle-kit` and applied at startup via `migrate()`. Key `from @napi-rs/keyring` (ADR-005); `FINTRACK_DB_KEY` env var overrides for CI/headless.

```
currencies          (code PK, symbol, name)
accounts            (id PK, name, type: checking|savings|wallet|investment|credit,
                     initial_balance, currency FK→currencies)
credit_cards        (id PK, name, currency FK, closing_day, due_day, limit_amount?,
                     account_id FK→accounts, payment_account_id FK→accounts)
categories          (id PK, name, kind: expense|income|both, parent_id FK→self, names JSON?)
merchants           (key PK)
merchant_category   (merchant_key FK, category_id FK — composite PK; weight, origin: rule|history)
tags                (id PK, name UNIQUE)
bills               (id PK, credit_card_id FK, month, year, close_date, due_date,
                     status: open|closed|paid, payment_transaction_id FK→transactions? —
                     UNIQUE(credit_card_id, month, year))
transactions        (id PK, description, amount, type: expense|income|transfer,
                     status: pending|effective DEFAULT effective,
                     date, currency, source: mcp|rest|import, idempotency_key UNIQUE,
                     classification_method, confidence, raw_input?, note?,
                     from_account_id FK, to_account_id FK,   ← transfer uses both (ADR-002)
                     credit_card_id FK, bill_id FK, category_id FK, subcategory_id FK,
                     merchant_key FK,
                     INDEX: (status, date) — supports scheduling queries)
transaction_tags    (transaction_id FK, tag_id FK — composite PK)
recurring_rules     (id PK, description, amount, type, period, next_due, currency,
                     account_id FK, category_id FK)

settings            (id PK DEFAULT 'singleton', locale: en|es|pt DEFAULT en,
                     locale_source: default|inferred|explicit DEFAULT default)
dashboards          (name PK, html, updated_at — ADR-013 Phase A; see § Dashboards / `/ui` surface)

transactions_fts    VIRTUAL TABLE fts5(description, content='transactions')
                    — kept in sync via INSERT/UPDATE/DELETE triggers
```

Repos live in `src/diplomat/db/repos/`; each accepts a `Db` (`LibSQLDatabase<typeof schema>`) injected from `main.ts`. Drizzle query builder is used for simple CRUD; `db.all(sql\`...\`)` for joins and FTS5 searches. All queries parameterized — never string-interpolate user input.

Seed data (currencies, categories, merchant rules) lives in `src/diplomat/db/seed/` (ADR-008). Seed-only types (`DefaultCategoryId`, `MerchantRule`) live there too — the domain never imports seed.

## Invariants (violations are bugs)

1. **Idempotency**: every Transaction write uses `UNIQUE(idempotency_key)` + `onConflictDoNothing()`; `rowsAffected === 0` means duplicate — return the existing row, `created: false`.
2. **Transfers** are `type: 'transfer'` with both `from_account_id` AND `to_account_id` set (ADR-002); summary/classification queries MUST exclude them (`t.type != 'transfer'`).
3. **Currency**: transactions denormalize the account/card currency at write time; aggregations group per currency, never convert.
4. **Balances are derived**, never stored: `initialBalance + income − expenses + transfers in − transfers out`. **Only `effective` transactions count** — pending transactions never affect the current balance. Projection (balance + pending-through-date) is opt-in via `projectedAsOf` on `get_account_balances`.
   - **Effective-only invariant (Feature Design 001)**: `get_account_balances` and `get_spending_summary` MUST filter `status = 'effective'`. Projection queries explicitly include `pending`. Classification ignores status. This is enforced in `diplomat/db/repos/` — violations are bugs.
5. **Classification via merchant_category**: normalized description → `merchants.key` → strongest `merchant_category` edge; user corrections increment `weight` (`onConflictDoUpdate`).
6. **Category kind must match transaction type**: `expense` transactions may only use `expense` or `both` categories;
   `income` may only use `income` or `both`. Enforced in `controllers/transaction/core.ts`'s `resolveCategory`/
   `resolveSubCategory` (shared by every movement path) via `isCategoryKindAllowed` (predicate in `logic/transaction.ts`).
7. **Sub-category always paired with parent**: `subcategory_id` set → `category_id` must also be set to the sub-category's parent. Enforced by a `CHECK` constraint and in `controllers/resolve.ts`.
8. **Card purchases are funded by the card's internal liability account (debt).** Bill payment is a canonical transfer (ADR-002) from a bank account to the card account, excluded from spending summaries — never an expense (double-count). `pay_bill` creates it, links it via `bills.payment_transaction_id`, and marks the bill paid. Value enters a `credit` account only via `pay_bill`. **A `paid` bill has at most one payment transfer** (Feature Design 011): created only by `pay_bill`, removed only by `revert_bill_payment` (which deletes the transfer and flips `paid → closed` — the exact inverse; both are idempotent no-ops outside that transition). A bill marked paid with a non-positive total has no transfer (`payment_transaction_id` absent) — revert still flips it to `closed`. **A `paid` bill is composition-immutable** (Feature Design 012): `add_card_purchase` rejects landing a transaction on a `paid` bill (whether by explicit `billMonth`/`billYear` or plain cycle auto-assignment), `update_transaction` rejects moving a transaction off a bill that is currently `paid`, and `delete_transaction` rejects any transaction whose `bill_id` points at a `paid` bill — not just the payment transfer (which is itself always covered, since its own `bill_id` is the bill it paid, even though the transfer itself has no `credit_card_id`; the composition-root router in `diplomat/transactionRouting.ts` keys `delete_transaction`'s dispatch on `billId`, not `cardId`, for exactly this case). Every case points the caller at `revert_bill_payment`; none of these guards ever auto-revert. `transactions.bill_id` is assigned automatically by cycle (`billPeriodFor`) or, when given, by an explicit `billMonth`/`billYear` (`billPeriodForCycle`) — either way via the shared `bills.ensureAndAttach` (auto-creates the target bill `open` if needed) — and is readable on `TransactionView` as `billId`. A transaction can only ever belong to a bill of its own card (structural: there is no way to change a transaction's card via `update_transaction`). All of this policy lives in the credit-card aggregate (`controllers/creditCard/transaction.ts`), never in the transaction core (ADR-016).
9. **Encryption on by default**: the database is always opened with an encryption key (from keychain or `FINTRACK_DB_KEY`). Opening without a key is a startup error. The key is never logged or committed (ADR-005).
10. Decode at the boundary: every external input and SQL row is zod-parsed before entering the domain.
11. **Dynamic query structure is composed only from whitelisted enum-keyed SQL fragments** (ADR-011); caller-supplied values are always parameter-bound; caller text is never concatenated into SQL. Exhaustive `Record<Enum, Fragment>` maps in `diplomat/db` are the only source of structural SQL; `assertNever` / TS exhaustiveness guards unmapped keys at compile time.
12. Behavior changes require tests: domain and boundary behavior updates must include unit tests in the same change (success and expected-failure paths).
13. **Category identity is the slug/id, not the localized name** (Feature Design 002, ADR-009). Default categories carry a JSON `names` column (`{"pt":"…","es":"…"}`); display name is resolved at read time as `names?.[locale] ?? name`. Merchant rules and classification key on the slug, never the display name. User-created categories have `names = null` and keep their literal `name`.
14. **Locale is AI-determined, stored, env-overridable** (Feature Design 002). `settings.locale` (`en|es|pt`), default `en`. Resolution: `FINTRACK_LOCALE` env → `settings.locale` → `'en'`. `set_locale` with `source: inferred` is rejected when `locale_source` is `explicit`.
15. **Seed is isolated (ADR-008).** Seed data lives in `diplomat/db/seed/`; the domain (`models/`, `logic/`, `controllers/`) never imports it. The app boots and works on an empty (unseeded) DB.
16. **Unbounded collections page by keyset cursor with the paginated envelope (ADR-014).** `search_transactions` (first mover) returns `{ items, nextCursor?, total? }`; `ORDER BY` is composed only from a whitelisted enum-keyed column map (`ORDER_BY_COLUMN` in `wire/db/transactions.ts`, turned into SQL only in `diplomat/db/repos/transactions.ts`), the same mechanism as invariant 11 applied to ordering — caller text never reaches `ORDER BY`. Cursors are opaque, zod-validated at the boundary, and bound to the `sort`/`dir` that produced them (a mismatch is a `validation` error). `total` is opt-in (`includeTotal`) — an extra same-WHERE `COUNT(*)`, never paid by sequential "walk until no `nextCursor`" consumers. Small, cycle-bounded `list_*` endpoints stay plain arrays; the envelope is the signal a collection can page.

## Tool surface

39 MCP tools (contract: `docs/mcp-tools.md`) and mirror REST routes, both thin over the same controllers. Client connections: `docs/mcp-clients.md`.

**Transport:** controlled by `MCP_TRANSPORT` (zod enum, `config.ts`). Default is **`stdio`** — the client spawns the process; no port, no Fastify. Set `MCP_TRANSPORT=http` to start the Fastify server (REST + streamable HTTP MCP on `PORT`). Both transports connect the same `buildMcpServer(deps, version)` core; no domain code moves. (ADR-007)

## HTTP sidecar (ADR-013 Decision 7)

In the default **stdio** transport, the HTTP server (REST + streamable HTTP MCP, `diplomat/http`/`diplomat/mcp`) runs alongside it as a **best-effort sidecar**, so `/api` and `/ui` are reachable by default — the dashboard experience is a core feature, not an add-on the user has to discover and opt into. Composed in `src/server.ts` (`buildHttpApp`, `startHttpSidecar`) and started from `main.ts`, the composition root — kept out of `diplomat/http`/`diplomat/mcp` so neither edge depends on the other.

- **On by default, opt-out via env:** `FINTRACK_HTTP` defaults to `true` (with `PORT`, default `51737` — see below), so the sidecar starts without any env var set. `FINTRACK_HTTP=false` is the only value that disables it (stdio-only, zero ports bound); any other value leaves it on.
- **Non-fatal bind failure is a fallback, not the normal state:** if the port can't be bound (most commonly `EADDRINUSE`), `startHttpSidecar` catches the error, logs an actionable message, and returns `{ listening: false }` instead of throwing. The stdio MCP connection — established before the sidecar is attempted — is unaffected either way; only `/api`/`/ui` stay unavailable for that run, and the user can diagnose the conflict from chat since stdio is still up.
- **stderr only, never stdout:** stdio carries the MCP protocol on stdout (ADR-007), so the sidecar's Fastify instance runs with `logger: false` and all sidecar messages (startup banner — including the `/ui/overview` URL so the user knows where to open the dashboard — and the bind-failure diagnostic) go through `console.error`.
- **Clean shutdown:** SIGINT/SIGTERM and stdin end/close (client disconnect) drain both the stdio server and the sidecar (only if it's actually listening) before the process exits.
- **Pure `http` mode is unchanged:** when `MCP_TRANSPORT=http`, the Fastify server (`buildHttpApp`, default `logger: true`) is the *only* surface running, so a bind failure there stays fatal (`process.exit(1)` with an actionable message) — there is no stdio fallback to keep the process alive. This is a deliberate, documented difference from the sidecar's non-fatal handling, not a regression.
- **Loopback-only bind (`common/net.ts`'s `LOOPBACK_HOST`, `127.0.0.1`):** both the sidecar and pure `http` mode bind `127.0.0.1` explicitly, never the `::`/`0.0.0.0` wildcard. This API has no auth (ADR-013 assumes local-first), and binding the wildcard address is reachable from any device on the same LAN, not just this machine — verified empirically, not just in theory. `localhost` may still fail to connect on systems where it resolves to IPv6 `::1`; clients should use `127.0.0.1` explicitly (`docs/mcp-clients.md`).
- **Default `PORT` differs by run mode, deliberately:** the published package (`config.ts`'s `DEFAULT_PORT`) defaults to `51737`, chosen because it sits in IANA's dynamic/private range (49152-65535) — never assigned to a registered service — rather than a common Node/Fastify/React dev-server port like 3000/3001/8080, which would maximize collision risk with other software on a typical machine. `npm run dev` overrides `PORT` back to the familiar `3001` (`package.json`), so a contributor's local dev instance never collides with an already-running installed instance on the published default. The two values are independent knobs, not a `NODE_ENV`-style branch in `config.ts` — only the npm script differs.

## OpenAPI contract (ADR-013 Phase A)

Every REST route is declared exactly once, in `diplomat/http/routes.ts`'s `buildRouteDefinitions(deps, version)` — a single array where each entry carries its method, path, `wire/in`/`wire/out`/`models`-derived request/response schemas, **and** its real handler together. There is no second, hand-maintained list to fall out of sync: `mountRoutes` (`diplomat/http/openapi.ts`) mounts the array on Fastify, and `buildOpenApiDocument` documents the same array via `@asteasolutions/zod-to-openapi`'s `OpenApiGeneratorV3` — neither function depends on the other, so a route that's mounted is, by construction, the same route that's documented. (An earlier version of this kept the route list and the OpenAPI registry as two separate, manually-synced files; that duplication was the actual defect, not something a parity test should merely detect after the fact — so the design was collapsed to one array instead. A unit test (`test/unit/diplomat/http/openapi.test.ts`) still checks the two consumers agree, mainly to guard against a future route being mounted by hand outside the array.)

The same document is exposed as the MCP resource `fintrack://openapi` (`diplomat/mcp/server.ts`), so a tools/resource-only agent — including under the **stdio** transport, which never starts Fastify — can read the contract without an HTTP round-trip. This is the first MCP resource in the app (as opposed to tools). It calls `buildOpenApiDocument(buildRouteDefinitions(deps, version), version)` directly: building the array only constructs handler closures (never invokes them), so it needs no live Fastify instance. `diplomat/mcp` importing `buildRouteDefinitions`/`buildOpenApiDocument` from `diplomat/http` is a narrow, documented exception to the dependency table (§ Dependency direction) — both are deterministic, no-business-logic builders, the same category of shared artifact both diplomats already import (wire schemas, models).

`diplomat/http/openapi.ts` holds only routing/doc-generation mechanics (`RouteDefinition`, `mountRoutes`, `buildOpenApiDocument`) — no wire schemas. Response shapes with no dedicated `wire/out` schema before this change (e.g. `BillView`, `ApplyDueResult`, the credit-card delete dry-run union, the shared `{ error }` envelopes for 404/409/422) got new small `wire/out` schemas (`wire/out/{bills,recurring,creditCards,common,errors}.ts`), same as any other response shape; request-side generic path-param/query shapes (`name`, `id`, `confirm`) got `wire/in/common.ts`. Unlike request schemas, these response schemas are not zod-validated at runtime (routes never parse their own outbound payloads), so they are best-effort documentation, not an enforced contract.

## Dashboards / `/ui` surface (ADR-013 Phase A/B)

The `dashboards` table (`name` PK, `html`, `updated_at`) stores agent-authored HTML shells, keyed by name — `save_dashboard` (MCP tool) / `POST /api/dashboards` (REST) is an **upsert**: saving to an existing name replaces its content immediately, no rebuild, restart, or migration. `GET /ui/:name` (mounted by `registerRoutes` in `diplomat/http/routes.ts`, same Fastify instance as `/api`, so it rides the HTTP sidecar per ADR-013 Decision 7) returns the currently-stored HTML as `text/html; charset=utf-8` with `cache-control: no-cache` — a regenerated dashboard is never masked by a stale browser copy. Absent name → `unknown_dashboard` (404).

Before persisting, `saveDashboard` (`controllers/dashboards.ts`) runs `findHtmlValidationIssues` (`logic/dashboard.ts`, pure) and rejects with `validation` (422) if it fails: no `<!doctype html>`/`<html>` root element, or an inline `<script>` that fails to *compile* (via Node's `vm.Script` — checked, never executed, so this can't itself run untrusted code). This is a narrow render-ability check, not sanitization: it exists because there was previously nothing stopping a broken save (e.g. a JS syntax error) from silently overwriting a working dashboard with no version history to recover from — full HTML sanitization remains explicitly out of scope for this local single-user app (ADR-013 Phase A). A rejected save never reaches `deps.dashboards.upsert`, so the previously stored dashboard is untouched.

`/ui/:name` is deliberately **not** part of the `/api` OpenAPI document: that document exists to give an agent correct `fetch()` shapes for the JSON data API (§ OpenAPI contract above), and `/ui` is a browser-facing HTML page, not a JSON contract. Management of dashboards (list/get/save) does have REST parity under `/api/dashboards*` and is documented in the OpenAPI spec like every other route.

A baseline dashboard (name `overview`) is seeded via `src/diplomat/db/seed/dashboards.ts` at bootstrap (ADR-008 seed isolation — consumed only by `diplomat/db/bootstrap.ts`, never imported by the domain), so `GET /ui/overview` resolves on a fresh install even before the agent has generated anything. Seeding uses `onConflictDoNothing` on the `name` primary key, so a `save_dashboard` override survives future restarts — bootstrap never re-seeds over a dashboard that already exists.

**(Phase B)** The seed is a single self-contained HTML string — layout, CSS, and vanilla JS all inline, with Chart.js loaded from a CDN as the only external resource. It renders income/expenses/balance, spending-by-category (chart + table), accounts & balances, recurring rules, and recent transactions, one block per currency, plus a clearly-labeled "coming soon" placeholder for installment projections (no endpoint exists yet — Phase C). On `DOMContentLoaded` it issues same-origin `fetch('/api/...')` calls against the routes documented at `GET /api/openapi.json` (`/api/summary`, `/api/aggregate`, `/api/accounts/balances`, `/api/recurring`, `/api/transactions`) and renders whatever comes back, using the localized labels the API already returns (`typeLabel`, `categoryName`, `periodLabel`, …) rather than hardcoding vocabulary. Every section has its own loading/empty/error state, so a slow or failing endpoint degrades one card instead of blanking the page. **The template embeds zero financial data or secrets** — this is the ADR-013 non-negotiable, and `test/integration/http/dashboardTemplate.test.ts` is a regression guard: it asserts the served HTML contains the expected `fetch()` calls, contains no inline-data-blob patterns (e.g. `const spending = [...]`), references no external host besides the Chart.js CDN, and that every fetched path exists in the live OpenAPI document.

**(Phase B)** `skills/dashboard-building/SKILL.md` is the guardrail checklist an MCP client follows to build or
adapt a dashboard for the user: read the contract (`fintrack://openapi`/`GET /api/openapi.json`) before
writing any `fetch()` call, map each requested section to a real endpoint, start from the baseline template
above as the structural pattern, then self-check the generated HTML (no embedded data, same-origin `/api`
only, the pinned Chart.js CDN script as the sole other external reference, per-currency grouping, localized
labels, loading/empty/error states) before calling `save_dashboard`. It is a docs-only artifact — no runtime
behavior depends on it — shipped in the published npm package via `package.json`'s `files` array so it's
available alongside the server.

## ADR index

- ADR-001: neverthrow for Result (reaffirmed vs fp-ts/Effect/Ramda)
- ADR-002: transfers are transactions with type 'transfer'
- ADR-003: remeda for declarative data transformation, with scope boundary
- ADR-004: local-first relational SQLite via libSQL (replaces Neo4j)
- ADR-005: OS keychain (`@napi-rs/keyring`) for encryption key storage
- ADR-006: Drizzle ORM for schema definition and migrations
- ADR-007: stdio as the default MCP transport, HTTP opt-in
- ADR-008: seed data lives in `diplomat/db/seed`; the domain never depends on it
- ADR-009: localized content lives on the entity (JSON `names`); i18n catalogs are for chrome only
- ADR-010: credit cards are liability accounts (1:1 internal `credit` account per card)
- ADR-011: safe composition of dynamic aggregation queries (whitelist enum→fragment maps + parameter binding)
- ADR-012: per-model error definitions; `common` composes `AppError` (supersedes the type-only `AppError` import exception)
- ADR-013: LLM-generated data-less local dashboards over the HTTP API
- ADR-014: cursor pagination + whitelisted ordering for collection endpoints (`search_transactions` first mover)
- ADR-015: multi-write unit-of-work for transactional multi-step writes — **rejected** (superseded by ADR-016 before implementation)
- ADR-016: domain/context boundaries — aggregate ownership (credit-card, account) over a shared transaction core
- ADR-017: no god write flows — bounded-context ownership for every transaction mutation (extends ADR-016; proposed)
