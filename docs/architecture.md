# FinTrack v2 — Architecture (as built)

> **This file describes the system as it IS.** Update it in the same change that alters architecture.
> Roadmap and vision: `docs/PLAN.md`. Decisions + rationale: `docs/adr/`. Agent instructions: `CLAUDE.md`.

## Stack

TypeScript (ESM, Node 22) · Fastify 5 · zod · neverthrow · remeda · Neo4j 5 · Docker Compose.
Surfaces: **MCP (primary)** at `POST /mcp` (streamable HTTP, stateless) and REST at `/api`.

## Diplomat layers

```
diplomat/http (Fastify)   diplomat/mcp (tools)        ← thin edges: parse, delegate, translate
            └────────┬────────┘
              controllers/                            ← effect composition: safeTry pipelines,
            (ResultAsync<T, AppError>)                  shared resolvers (resolve.ts)
        ┌────────────┼────────────┐
   logic/ (pure)  adapters/   diplomat/db (Cypher)    ← logic: no I/O ever; db: parameterized only
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
| `controllers/` | `logic/`, `models/`, `wire/in`, `common/`, injected deps interfaces |
| `logic/` | `logic/`, `models/` only |
| `models/` | zod/schema helpers only |
| `adapters/` | `models/`, `wire/*` |
| `diplomat/*` | `controllers/`, `adapters/`, `models/`, wire schemas, runtime clients |

### Boundary schemas and adapter naming

- External shapes belong to `src/wire/`, split by intent:
  - `wire/in`: inbound contracts from clients/resources (request payloads, tool args, events).
  - `wire/out`: outbound contracts exposed by this service (responses, published payloads).
  - `wire/db`: storage-facing contracts (db rows/records/properties).
- Domain layer (`controllers/`, `logic/`, `models/`) stays agnostic to wire schemas and infrastructure tools.
- Adapter functions should be grouped per domain and named by direction, for example:
  - `wireInToModel`
  - `modelToWireOut`
  - `modelToDb`
  - `dbToModel`
- In call sites, prefer namespace imports for clarity, e.g. `import * as transactionAdapters from '../adapters/transactions.js'` then `transactionAdapters.modelToDb(...)`.

## Graph model (as built)

```
(:Currency {code: BRL|USD, symbol, name})
(:User)                                              // future multi-user; not yet enforced
(:Account {id, name, type: checking|savings|wallet|investment, initialBalance})
(:Account|:CreditCard)-[:DENOMINATED_IN]->(:Currency)
(:CreditCard {id, name, closingDay, dueDay, limit?})

(:Transaction {id, description, amount, type: expense|income|transfer, date, currency,
               source: mcp|rest|import, idempotencyKey UNIQUE, classificationMethod, confidence, rawInput?})
(:Transaction)-[:FROM]->(:Account)                   // source account (also transfer origin)
(:Transaction)-[:TO]->(:Account)                     // transfer destination only (ADR-002)
(:Transaction)-[:CHARGED_TO]->(:CreditCard)
(:Transaction)-[:IN]->(:Category {id, name, kind})
(:Transaction)-[:AT]->(:Merchant {key UNIQUE})

(:Merchant)-[:USUALLY {weight, origin: rule|graph}]->(:Category)   // the classifier IS these edges
(:Bill {id, month, year, closeDate, dueDate, status: open|closed|paid})-[:OF]->(:CreditCard)
(:Bill)-[:CONTAINS]->(:Transaction)                  // fatura, auto-created open per cycle
(:RecurringRule {id, description, amount, type, period, nextDue, currency})-[:FROM|:IN]->(...)
```

## Invariants (violations are bugs)

1. **Idempotency**: every Transaction write MERGEs on `idempotencyKey`; repeat = `created: false`.
2. **Transfers** are `type: 'transfer'` with BOTH `[:FROM]` and `[:TO]`; summary/classification queries MUST exclude them (`t.type <> 'transfer'`).
3. **Currency**: transactions denormalize the account/card currency; aggregations group per currency, never convert.
4. **Balances are derived**, never stored: `initialBalance + income − expenses + transfers in − transfers out`.
5. **Classification is graph traversal**: normalized description → `:Merchant` → strongest `[:USUALLY]` edge; user corrections strengthen edges (learning loop in `update_transaction`).
6. **pay_bill flips status only** — a payment transaction would double-count card expenses.
7. Decode at the boundary: every external input and Cypher record is zod-parsed.
8. Behavior changes require tests: domain and boundary behavior updates must include unit tests in the same change (success and expected-failure paths).

## Tool surface

17 MCP tools (contract: `docs/mcp-tools.md`) and mirror REST routes, both thin over the same controllers. Client connections: `docs/mcp-clients.md`.

## ADR index

- ADR-001: neverthrow for Result (reaffirmed vs fp-ts/Effect/Ramda)
- ADR-002: transfers are transactions with type 'transfer'
- ADR-003: remeda for declarative data transformation, with scope boundary
