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
| `models/` | zod/schema helpers; plus **type-only** `common/errors` (`AppError`) to colocate expected-error payloads with the entity they describe (see "Domain ownership" below). `common/errors` must stay pure (no I/O). |
| `adapters/` | `models/`, `wire/*` |
| `diplomat/*` | `controllers/`, `adapters/`, `models/`, wire schemas, runtime clients |
| `diplomat/db/seed/` | `models/` (types and runtime enums) — nothing outside `diplomat/db` imports `seed/` |

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
- **Expected-error payloads are domain vocabulary.** The `AppError` objects a controller returns for a given entity (e.g. `accountErrors.creditRejected`, `accountErrors.duplicateName(name)`) are colocated on that entity's model, typed against `AppError` (type-only import). Controllers *raise* them (`guard(condition, accountErrors.X)`) but never author the `{ code, … }` literal inline.
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
                     status: open|closed|paid — UNIQUE(credit_card_id, month, year))
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
6. **Category kind must match transaction type**: `expense` transactions may only link to `expense` or `both` categories; `income` to `income` or `both`. Enforced in `controllers/resolve.ts#guardCategoryKind`.
7. **Sub-category always paired with parent**: `subcategory_id` set → `category_id` must also be set to the sub-category's parent. Enforced by a `CHECK` constraint and in `controllers/resolve.ts`.
8. **Card purchases are funded by the card's internal liability account (debt).** Bill payment is a canonical transfer (ADR-002) from a bank account to the card account, excluded from spending summaries — never an expense (double-count). `pay_bill` creates it and marks the bill paid. Value enters a `credit` account only via `pay_bill`.
9. **Encryption on by default**: the database is always opened with an encryption key (from keychain or `FINTRACK_DB_KEY`). Opening without a key is a startup error. The key is never logged or committed (ADR-005).
10. Decode at the boundary: every external input and SQL row is zod-parsed before entering the domain.
11. Behavior changes require tests: domain and boundary behavior updates must include unit tests in the same change (success and expected-failure paths).
12. **Category identity is the slug/id, not the localized name** (Feature Design 002, ADR-009). Default categories carry a JSON `names` column (`{"pt":"…","es":"…"}`); display name is resolved at read time as `names?.[locale] ?? name`. Merchant rules and classification key on the slug, never the display name. User-created categories have `names = null` and keep their literal `name`.
13. **Locale is AI-determined, stored, env-overridable** (Feature Design 002). `settings.locale` (`en|es|pt`), default `en`. Resolution: `FINTRACK_LOCALE` env → `settings.locale` → `'en'`. `set_locale` with `source: inferred` is rejected when `locale_source` is `explicit`.
14. **Seed is isolated (ADR-008).** Seed data lives in `diplomat/db/seed/`; the domain (`models/`, `logic/`, `controllers/`) never imports it. The app boots and works on an empty (unseeded) DB.

## Tool surface

32 MCP tools (contract: `docs/mcp-tools.md`) and mirror REST routes, both thin over the same controllers. Client connections: `docs/mcp-clients.md`.

**Transport:** controlled by `MCP_TRANSPORT` (zod enum, `config.ts`). Default is **`stdio`** — the client spawns the process; no port, no Fastify. Set `MCP_TRANSPORT=http` to start the Fastify server (REST + streamable HTTP MCP on `PORT`). Both transports connect the same `buildMcpServer(deps, version)` core; no domain code moves. (ADR-007)

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
