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

## Architecture guidance

Architecture and domain behavior are documented in canonical docs and should not be duplicated here.

Before changing architecture-related code, read:

- `docs/architecture.md` (as-built project architecture, invariants, dependency direction)
- `docs/diplomatic-architecture.md` (core Diplomat concepts)
- `docs/code-style.md` (controller/logic/adapters implementation patterns)

Agent-level non-negotiables:

- Keep `diplomat/*` thin (parse/delegate/translate) and put orchestration in controllers.
- Keep `logic/*` pure (no I/O or runtime state reads).
- Decode external boundaries with zod and keep expected failures on the Result track.
- If behavior changes, update `docs/architecture.md` in the same change.

Layer rules (enforce in review — violations are bugs):

- `logic/` never imports `diplomat/`, `controllers/`, or anything that does I/O.
- `diplomat/` contains no business logic — it parses, delegates, and translates.
- Controllers return `ResultAsync<T, AppError>` (neverthrow) for **expected** failures (unknown account, ambiguous category…); unexpected errors throw and become 500s.
- Decode at the boundary: every external input (HTTP body, MCP args, Cypher records) is zod-parsed before entering the domain.
- Fastify routes: use `reply.send()` consistently — never mix with bare `return` in the same handler, as it causes hard-to-debug double-send issues.

## FP conventions (ADR-001, ADR-003)

This is a quick operational summary for agents. Canonical wording lives in `docs/architecture.md` and `docs/code-style.md`.

One concern per library — don't cross them:

- **zod**: schemas + boundary decoding only.
- **neverthrow**: control flow for fallible operations. Controllers compose via `safeTry` generator pipelines — each `yield*` short-circuits on `err` (Railway-Oriented). Shared combinators: `guard`/`okOr` (`common/result.ts`), entity resolvers (`controllers/resolve.ts`). Controllers return `ResultAsync`; diplomats just `await` them.
- **remeda**: pure data reshaping in `logic/`/`adapters/` (`pipe`, `groupBy`, `sortBy`, `sumBy`, `countBy`, `firstBy`). Use when a transformation has ≥2 stages or needs grouping; native `map`/`filter` is fine for trivial cases.

## Data conventions

This is a quick operational summary for agents. Canonical wording lives in `docs/architecture.md`.

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
- Transfers: transactions with `type: 'transfer'` and BOTH `[:FROM]`/`[:TO]` account edges (ADR-002) — one structure for the whole extrato. Summary/classification queries MUST exclude `t.type = 'transfer'`. Same-currency only until FX lands.
- Balances: derived, never stored — `initialBalance + income − expenses + transfers in − transfers out`. Transactions AND transfers both move balances.
- Cypher queries: always use parameterized queries (`$param`) — never interpolate user input into query strings.

## Documentation map (read before generating)

- `docs/architecture.md` — the system **as built**: graph model, invariants, layer rules. The source of truth when generating code; if your change alters it, update it in the same change.
- `docs/diplomatic-architecture.md`: The Diplomatic Architecture core concepts.
- `docs/code-style.md` — code style with do/don't examples (safeTry controllers, remeda pipelines, zod-only types). Generated code MUST match these patterns.
- `docs/PLAN.md` — roadmap/vision; updated at phase boundaries, may lag the as-built state.
- `docs/adr/` — decisions with rationale; never contradict an accepted ADR without writing a new one.
- `docs/mcp-tools.md` — MCP tool contract. `docs/mcp-clients.md` — client connection guide.

## Process

- Architecture decisions get an ADR in `docs/adr/` (use the engineering:architecture skill).
- Docs are updated in the same change that alters behavior — `docs/architecture.md` for structural changes, `docs/mcp-tools.md` for tool changes.
- New MCP tools must be documented in `docs/mcp-tools.md` with schema, error codes, and an example.
- Commit messages follow Conventional Commits: `type(scope): description`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Use `!` or `BREAKING CHANGE:` footer for incompatible changes.

## Tech debt

When a known trade-off is deliberately deferred during a PR or feature — a performance optimization, a correctness edge case, a refactor — create a **GitHub Issue** to track it. Do not create local markdown files for this purpose.

The issue body should include:
- What the current code does and why it's suboptimal
- The improved approach (with code/query snippet if applicable)
- Why it was deferred
- When it should be tackled (trigger condition or milestone)
- Rough effort estimate

After creating the issue, reference it in the PR description or review thread so the connection is traceable.
