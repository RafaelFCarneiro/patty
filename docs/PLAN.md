# FinTrack v2 — AI-First Architecture Plan

**Date:** 2026-06-09 · **Status:** Draft v2 (stack revised: diplomat / Fastify / zod / Neo4j)

> This is the **roadmap/vision** document — it reflects the plan as written and is updated at phase
> boundaries. For the system **as built today**, read `docs/architecture.md` (kept current with every
> architectural change). Decisions + rationale live in `docs/adr/`.

## Decisions

| Decision | Choice |
|---|---|
| Codebase | Greenfield rewrite (v1 is functional reference only) |
| Architecture | Diplomat architecture (Nubank-style), functional programming approach |
| Stack | TypeScript, Fastify, zod, Neo4j |
| MCP server | Inside the backend — MCP tools are diplomats over the same controllers as REST |
| Users | Single-user first; `userId` on every node for future multi-user |
| Currency | Multi-currency from day one: BRL + USD. Currency lives on Account/CreditCard; transactions inherit it |
| Infra | Everything in docker-compose: `neo4j` + `backend` services |
| AI layer | Claude clients (Desktop/Cowork/Code) via MCP; no LLM calls inside the backend |

## Vision

The AI chat is the primary interface. REST API and web dashboard are secondary surfaces over the same controllers. The user says "paguei 32,50 de Uber ontem" and the system resolves account, merchant, category, and date — no forms. The graph model makes relationships (merchant↔category, transaction↔transaction similarity, spending correlations) first-class data, powering classification and correlation analysis.

## Architecture — Diplomat

```
            Claude client                    HTTP clients / future web UI
                 │ MCP (streamable HTTP)            │ REST
                 ▼                                  ▼
┌──────────────────────────── diplomat/ (all I/O lives here) ─────────────────┐
│   mcp/ (tool registrations)      http/ (Fastify routes)      db/ (neo4j)    │
└───────────────┬──────────────────────────┬───────────────────────┬──────────┘
                ▼                          ▼                       ▲
┌─────────────────── controllers/ (orchestration, side-effect composition) ───┐
└───────────────┬──────────────────────────────────────────────────────────┬──┘
                ▼                                                          │
┌────────── logic/ (pure functions only) ──────────┐   ┌── adapters/ ──────┴──┐
│  classification rules · budget math · recurring  │   │ wire ↔ model ↔ cypher│
│  detection · summary/aggregation shaping         │   │ translations         │
└──────────────────────────────────────────────────┘   └──────────────────────┘
                         models/ (zod schemas — single source of truth)
```

Layer rules (enforced by convention + lint):

- `logic/` — pure functions, no I/O, no Date.now(), fully unit-testable.
- `controllers/` — the only place side effects are composed; calls diplomats and logic.
- `diplomat/` — edges: Fastify routes, MCP tool handlers, Neo4j queries. Thin; no business logic.
- `adapters/` — pure translation between external representations and internal models.
- `models/` — zod schemas. One schema drives: REST validation (`fastify-type-provider-zod`), MCP tool inputSchema (the MCP TS SDK is zod-native), Neo4j result decoding (parse at the boundary), and inferred TS types.

FP conventions: immutable data, function composition over classes, `Result`/`Either` for expected failures (consider `neverthrow` or `fp-ts`), decode-at-the-boundary everywhere.

## Graph data model (Neo4j)

```
(:Currency {code: "BRL" | "USD", symbol, name})
(:User)-[:OWNS]->(:Account {type})-[:DENOMINATED_IN]->(:Currency)
(:User)-[:OWNS]->(:CreditCard)-[:DENOMINATED_IN]->(:Currency)
(:Transaction {amount, date, description, type, source, rawInput,
               idempotencyKey, confidence, classificationMethod})
(:Transaction)-[:FROM]->(:Account)
(:Transaction)-[:CHARGED_TO]->(:CreditCard)
(:Bill {month, year, closeDate, dueDate, status: open|closed|paid})
(:Bill)-[:OF]->(:CreditCard)
(:Bill)-[:CONTAINS]->(:Transaction)                              // fatura
(:Transaction)-[:IN]->(:Category)<-[:CHILD_OF]-(:Category)     // hierarchy
(:Transaction)-[:AT]->(:Merchant)
(:Transaction)-[:TAGGED]->(:Tag)
(:Merchant)-[:USUALLY {weight, lastSeen}]->(:Category)          // learned classifier
(:Transaction)-[:RECURS_WITH {period, similarity}]->(:Transaction)
(:Budget {month, year, limit})-[:FOR]->(:Category)
(:Goal {target, deadline, saved})
(:RecurringRule {period, nextDue})-[:TEMPLATE_OF]->(:Transaction)
```

Conventions:

- **Currency**: every Account and CreditCard is `[:DENOMINATED_IN]` exactly one `:Currency` (seed: BRL, USD; extensible). Transactions store a denormalized `currency` property (copied from their account/card at write time) so aggregations never need an extra hop. Summaries and budgets are **always grouped per currency** — no implicit conversion. Cross-currency totals are a later feature requiring an FX-rate source (open question).
- Amounts in full units of the transaction's currency (reais or dollars). Dates as ISO strings; month/year filtering via date range in Cypher.
- `idempotencyKey` unique constraint on `:Transaction` — agents retry, duplicate writes must be safe.
- `rawInput` stores the original natural-language text for MCP-created transactions (audit + classifier training).
- `:Merchant` nodes are normalized from descriptions (`UBER *TRIP SP` → `uber`) by pure logic functions; the merchant node is what accumulates classification knowledge.
- Constraints/indexes: unique `(u.userId)`, unique `(t.idempotencyKey)`, range index on `t.date`.

Why graph: classification becomes traversal (see below); recurring detection becomes similarity edges; correlation questions ("which categories move together?", "what changed when I started ordering delivery?") are native Cypher instead of contorted aggregation pipelines.

## MCP tool design

Principles: tools accept **natural inputs** (names, aliases, relative dates) and the diplomat/adapters resolve them; every write idempotent; destructive actions support `dryRun`; structured errors the agent can self-correct from (e.g. `{ error: "ambiguous_account", candidates: [...] }`). All tool input/output schemas are zod — shared with REST.

### Write tools

| Tool | Notes |
|---|---|
| `create_transaction` | `{ description, amount, type, date?, account?, category?, idempotencyKey }`. Missing category/merchant resolved by graph classification; returns `{ transaction, classification: { method, confidence } }` so the agent can confirm low-confidence cases with the user. |
| `create_transactions_bulk` | Statement paste / import. Per-item results: created, duplicate-skipped, needs-review. |
| `update_transaction` / `delete_transaction` | Delete requires `confirm: true` after a dry-run echo. User category corrections strengthen `[:USUALLY]` edges. |
| `create_account` / `create_category` / `create_budget` / `create_goal` / `create_recurring` | Name-based refs resolved server-side. |

### Read / analysis tools

| Tool | Notes |
|---|---|
| `search_transactions` | Free text + structured filters (period, category, account, merchant, amount range, tags). |
| `get_spending_summary` | Income, expenses, balance, budget status for a period. |
| `aggregate_spending` | The dashboard primitive: `group_by` (category/account/tag/month/merchant), `period`, `filters`, `metric`. Parameterized Cypher templates — never raw client-supplied Cypher. |
| `find_correlations` | Graph-native analysis: co-occurring categories, spending pattern shifts, merchant clusters, recurring candidates. The differentiator tool. |
| `save_view` / `list_views` | Persist a named `aggregate_spending`/`find_correlations` parameterization as a reusable dashboard view (`{ name, tool, params, chartHint }`). |
| `get_budget_status` / `get_goals_progress` | Budget burn and goal tracking. |

### MCP resources & prompts

- Resources: `fintrack://categories`, `fintrack://accounts`, `fintrack://merchants/top` — taxonomy without tool round-trips.
- Prompts: `monthly_review`, `import_statement`, `budget_checkup`.

## Classification — graph traversal, deterministic

1. **Merchant edge**: normalize description → match `:Merchant` → follow strongest `[:USUALLY]->(:Category)` edge. Weight = frequency × recency.
2. **Rules seed**: BR-common merchants pre-seeded as `:Merchant`-`[:USUALLY]` edges (uber/99 → Transporte, ifood → Alimentação, …).
3. **Fallback**: return `category: null, confidence: 0` — the Claude client suggests a category in chat; user confirmation writes back a new/strengthened `[:USUALLY]` edge.

Every user correction updates edge weights. `classificationMethod` (`rule | graph | user`) + `confidence` stored on the transaction keep it auditable. No API keys, no per-transaction LLM cost; the classifier *is* the graph.

## Project structure

```
src/                             # backend lives at repo root
  main.ts                        # Fastify boot: REST plugin + MCP transport
  diplomat/
    http/                        # Fastify route plugins per domain
    mcp/                         # MCP tool/resource/prompt registrations
    db/                          # neo4j-driver queries (parameterized Cypher)
  controllers/                   # one per domain: transactions, accounts, ...
  logic/                         # pure: classification, budgets, recurring, summaries
  adapters/                      # wire ↔ model ↔ cypher-record translations
  models/                        # zod schemas (single source of truth)
  common/                        # Result helpers, idempotency, name resolution
docs/
  PLAN.md
  adr/                           # architecture decision records
skills/                          # Claude skills: monthly-review, import-statement, ...
Dockerfile                       # multi-stage: deps → build → slim runtime
docker-compose.yml               # neo4j + backend
CLAUDE.md                        # dev guidance for AI agents (commands, layer rules)

../fintrack-legacy/              # archived v1 (NestJS/Mongo/React), reference only
```

Config via env (`NEO4J_URI`, `NEO4J_AUTH`, `PORT`, `MCP_PATH`) — no hardcoded connections.

## Infrastructure — docker-compose

All infra runs via `docker compose up`:

| Service | Image / build | Ports | Notes |
|---|---|---|---|
| `neo4j` | `neo4j:5-community` | 7474 (browser), 7687 (bolt) | Volume for data; healthcheck on bolt; `NEO4J_AUTH` from `.env` |
| `backend` | `backend/Dockerfile` | 3001 (REST + MCP) | `depends_on: neo4j (healthy)`; dev profile mounts `src/` with `tsx watch` for hot reload; prod stage runs compiled output |

Dev loop: `docker compose up neo4j -d` + local `npm run dev` for fast iteration, or `docker compose --profile dev up` to run everything containerized. Seed script (currencies, BR categories, merchant rules) runs idempotently on backend boot.

## Development workflow — skills, MCPs, agents, docs

How we'll build this, using the AI tooling already available:

### Skills (engineering plugin — already installed)

| Phase | Skill | Use |
|---|---|---|
| Before each phase | `engineering:architecture` | One ADR per structural decision (Result lib, fatura modeling, FX approach) into `docs/adr/` |
| Design | `engineering:system-design` | API/tool contract reviews before implementing |
| During dev | `engineering:testing-strategy` | Test plan per module; golden-set design for the classifier |
| During dev | `engineering:debug` | Structured debugging sessions |
| Before merge | `engineering:code-review` | Review every diff: layer-boundary violations, Cypher injection, missing edge cases |
| Docs | `engineering:documentation` | READMEs, MCP tool contract docs, runbooks |
| Release | `engineering:deploy-checklist` | Pre-release verification once there's a deploy target |

### MCPs

- **GitHub** (engineering plugin): PRs, issues, CI status — connect when the repo goes remote.
- **Neo4j** (`mcp-neo4j-cypher`, official Neo4j MCP server): add as a local MCP pointed at the dev container — lets Claude inspect/query the graph directly during development instead of going through cypher-shell.
- **FinTrack's own MCP**: from Phase 1 exit onward, dogfood it — the app's MCP server is also its best integration test surface.

### Agents

- **Plan agent** before each phase: implementation plan against PLAN.md.
- **Explore agent** for codebase questions once the code grows.
- **Code-review subagent** as the verification step on every significant change (paired with `engineering:code-review`).

### Structured .md files (development process docs)

| File | Purpose |
|---|---|
| `CLAUDE.md` (root, rewritten for v2) | Commands, architecture map, **layer rules as explicit constraints** ("logic/ never imports diplomat/"), data conventions — the contract every AI session works under |
| `docs/PLAN.md` | This file — living roadmap, updated at phase boundaries |
| `docs/adr/NNN-*.md` | One record per decision; written via the architecture skill |
| `docs/mcp-tools.md` | The MCP tool contract: schemas, error codes, examples — doubles as agent-facing documentation |
| `docs/testing.md` | Test strategy + golden-set maintenance guide |

Rule: docs are updated in the same change that alters behavior — checked during code review, not after.

## Roadmap

### Phase 1 — Skeleton + MCP MVP
Docker-compose (neo4j + backend) with healthchecks; Fastify + zod scaffold with diplomat layout; constraints + seed (currencies BRL/USD, BR categories, merchant rules); models and controllers for accounts, categories, transactions; MCP diplomats for `create_transaction`, `search_transactions`, `get_spending_summary`; idempotency; root `CLAUDE.md` + first ADRs. **Exit:** `docker compose up`, then create and query transactions (in BRL or USD) from Claude chat, classified via seeded merchant edges.

### Phase 2 — Classification loop + bulk input ✅ (2026-06-11)
Merchant normalization logic; `[:USUALLY]` weight learning from corrections; `create_transactions_bulk`; credit cards with `:Bill` lifecycle (open → closed → paid) + recurring rules. **Exit:** paste a statement → classified transactions with confidence flags; corrections improve future classification.

### Phase 3 — Insights + graph analysis
`aggregate_spending`, `find_correlations`, budgets, goals, saved views; MCP resources + prompts; monthly-review and import-statement skills. **Exit:** "how was my spending vs budget, and what's driving the change?" answered with composed graph queries; views persist.

### Phase 4 — Surfaces & hardening
Minimal web frontend rendering saved views; activate `userId` for multi-user groundwork; OFX/CSV importers behind an interface (Open Finance Brasil / Pluggy later); e2e against MCP transport.

## Testing

- `logic/`: plain jest/vitest unit tests — pure functions, no mocks needed. This is where FP pays off.
- Diplomat/db: integration tests against ephemeral Neo4j (testcontainers).
- MCP e2e: drive tools through the MCP SDK client — the contract that matters most.
- Golden set: ~100 realistic BR transaction descriptions with expected categories; classification accuracy tracked as a regression test.

## Risks & mitigations

- **Neo4j ergonomics**: no Mongoose equivalent — mitigated by zod decode-at-boundary and keeping all Cypher in `diplomat/db/` as parameterized templates.
- **Simple aggregations are wordier in Cypher** than in a document DB — acceptable at single-user scale; the correlation upside is the point.
- **Diplomat discipline** is convention, not framework-enforced — add ESLint import-boundary rules (`logic/` may not import `diplomat/`).

## Open questions

- ~~Credit card invoices~~ **Decided**: faturas are `:Bill` nodes (`(:Bill)-[:OF]->(:CreditCard)`, `(:Bill)-[:CONTAINS]->(:Transaction)`). "Bill" over "Invoice" — invoice is B2B; "bill" matches everyday usage and Nubank's own API naming. Bills carry `closeDate`/`dueDate`/`status`; card transactions attach to the open bill at write time.
- `Result` library: `neverthrow` (lighter) vs `fp-ts` (deeper FP, steeper). Decide in Phase 1 (ADR).
- Cross-currency conversion: which FX-rate source (BCB PTAX API is free and official for BRL/USD), and whether to store the rate on the transaction at write time or convert at read time. Until decided, all analytics are per-currency.
