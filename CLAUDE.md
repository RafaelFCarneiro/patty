# CLAUDE.md

Guidance for AI agents working in this repository.

## Project overview

FinTrack v2 is an AI-first personal finance manager. The primary interface is AI chat (Claude clients) talking to the backend's **MCP server**; REST is a secondary surface. Backend: TypeScript, Fastify, zod, Neo4j, diplomat architecture, functional programming style. Full plan: `docs/PLAN.md`. v1 (NestJS/Mongo/React) is archived in the sibling repo folder `../fintrack-legacy` as functional reference only — never modify it.

## Development setup

```bash
npm install
npm run infra:up:db   # Neo4j only (browser UI: http://localhost:7474, neo4j / fintrack123)
npm run dev           # REST + MCP on http://localhost:3001
# or run everything containerized:
npm run infra:up
```

- REST API: `http://localhost:3001/api`
- MCP endpoint (streamable HTTP): `http://localhost:3001/mcp`
- Run `npx ntl` for an interactive, described list of all scripts.

## Commands

```bash
npm run dev             # tsx watch
npm run build           # tsc (tsconfig.build.json)
npm start               # node dist/main.js
npm test                # vitest run (unit tests, colocated *.test.ts)
npm run typecheck       # tsc --noEmit (includes tests)
npm run infra:up        # build + start all containers (neo4j + backend)
npm run infra:up:db     # start only neo4j
npm run infra:down      # stop containers (keeps data)
npm run infra:down:clean # stop containers and WIPE the db volume
npm run mcp:inspect     # MCP Inspector — connect to http://127.0.0.1:3001/mcp
```

Run a single test file: `npx vitest run src/logic/classify.test.ts`

The backend lives at the repo root (`src/`, `package.json`) — there is no `backend/` subfolder.

## Architecture — diplomat (STRICT layer rules)

```
src/
  models/        zod schemas — single source of truth for types (REST, MCP, db decoding)
  logic/         PURE functions only. No I/O, no Date.now(), no imports from diplomat/ or controllers/
  adapters/      pure translation: cypher records ↔ models, wire ↔ models
  controllers/   orchestration; the ONLY place side effects are composed. Receives deps (repos, clock) as arguments
  diplomat/
    db/          neo4j-driver, parameterized Cypher ONLY (never interpolate user input), constraints + seed
    http/        Fastify routes — thin: zod-parse body → call controller → map Result to status
    mcp/         MCP tool registrations — thin, same controllers as http
  common/        AppError types, shared helpers
```

Layer rules (enforce in review — violations are bugs):

- `logic/` never imports `diplomat/`, `controllers/`, or anything that does I/O.
- `diplomat/` contains no business logic — it parses, delegates, and translates.
- Controllers return `Result<T, AppError>` (neverthrow) for **expected** failures (unknown account, ambiguous category…); unexpected errors throw and become 500s.
- Decode at the boundary: every external input (HTTP body, MCP args, Cypher records) is zod-parsed before entering the domain.

## Data conventions

- IDs: `crypto.randomUUID()`; seeded nodes use stable slugs (`cat-transporte`).
- Currency: BRL and USD seeded. Accounts/cards are `[:DENOMINATED_IN]` one `:Currency`; transactions carry a denormalized `currency` property. Summaries always group per currency — never convert implicitly.
- Amounts: full units (reais/dollars), positive numbers; `type` (`expense`/`income`) carries the sign.
- Dates: `YYYY-MM-DD` strings; month/year filters become date ranges in Cypher.
- Idempotency: every transaction write requires `idempotencyKey` (unique constraint); repeated writes return the existing node with `created: false`.
- Classification: `classificationMethod` (`rule|graph|user|none`) + `confidence` stored on every transaction; merchant knowledge lives on `(:Merchant)-[:USUALLY {weight}]->(:Category)` edges.
- MCP-created transactions store `rawInput` (original natural-language text).
- Credit cards: transactions are `[:CHARGED_TO]` a card and `[:CONTAINS]`-ed by the cycle's `:Bill` (fatura), auto-created `open` based on the card's `closingDay`. `pay_bill` only flips status — never creates a payment transaction (would double-count).
- Recurring: `:RecurringRule` with `nextDue`; materialized by `apply_due_recurring` with stable keys `rec-<ruleId>-<date>`.
- Bulk import: idempotency keys derived from `date+description+amount`; items with confidence < 0.6 are flagged `needs_review`, not blocked.
- Transfers: `:Transfer` nodes (`[:FROM]`/`[:TO]` accounts) — never expenses/income, never in summaries. Same-currency only until FX lands.
- Balances: derived, never stored — `initialBalance + income − expenses + transfers in − transfers out`. Transactions AND transfers both move balances.

## Process

- Architecture decisions get an ADR in `docs/adr/` (use the engineering:architecture skill).
- Docs are updated in the same change that alters behavior.
- New MCP tools must be documented in `docs/mcp-tools.md` with schema, error codes, and an example.
