# FinTrack v2 — AI-First Architecture Plan

**Date:** 2026-06-09 · **Status:** Draft v2 (stack: diplomat / Fastify / zod / libSQL + Drizzle)

> This is the **roadmap/vision** document — it reflects the plan as written and is updated at phase
> boundaries. For the system **as built today**, read `docs/architecture.md` (kept current with every
> architectural change). Decisions + rationale live in `docs/adr/`.
>
> **Note (post-ADR-004):** this plan was originally drafted around Neo4j. The project migrated to a
> local-first encrypted libSQL (SQLite) + Drizzle stack — see ADR-004/005/006 and `docs/architecture.md`
> for the as-built relational model. Graph-specific phrasing below is retained only as historical vision.

## Decisions

| Decision | Choice |
|---|---|
| Codebase | Greenfield rewrite (v1 is functional reference only) |
| Architecture | Diplomat architecture (Nubank-style), functional programming approach |
| Stack | TypeScript, Fastify, zod, libSQL (encrypted local SQLite) + Drizzle ORM (ADR-004/006) |
| MCP server | Inside the backend — MCP tools are diplomats over the same controllers as REST |
| Users | Single-user first; schema carries owner columns for future multi-user |
| Currency | Multi-currency from day one: BRL + USD. Currency lives on Account/CreditCard; transactions inherit it |
| Infra | Zero external infra — a local encrypted `fintrack.db` file (key in OS keychain, ADR-005) |
| AI layer | Claude clients (Desktop/Cowork/Code) via MCP; no LLM calls inside the backend |

## Vision

The AI chat is the primary interface. REST API and web dashboard are secondary surfaces over the same controllers. The user says "paguei 32,50 de Uber ontem" and the system resolves account, merchant, category, and date — no forms. The graph model makes relationships (merchant↔category, transaction↔transaction similarity, spending correlations) first-class data, powering classification and correlation analysis.

## Architecture — Diplomat

```
            Claude client                    HTTP clients / future web UI
                 │ MCP (streamable HTTP)            │ REST
                 ▼                                  ▼
┌──────────────────────────── diplomat/ (all I/O lives here) ─────────────────┐
│  mcp/ (tool registrations)    http/ (Fastify routes)    db/ (libSQL+Drizzle) │
└───────────────┬──────────────────────────┬───────────────────────┬──────────┘
                ▼                          ▼                       ▲
┌─────────────────── controllers/ (orchestration, side-effect composition) ───┐
└───────────────┬──────────────────────────────────────────────────────────┬──┘
                ▼                                                          │
┌────────── logic/ (pure functions only) ──────────┐   ┌── adapters/ ──────┴──┐
│  classification rules · budget math · recurring  │   │ wire ↔ model ↔ db    │
│  detection · summary/aggregation shaping         │   │ translations         │
└──────────────────────────────────────────────────┘   └──────────────────────┘
                         models/ (zod schemas — single source of truth)
```

Layer rules (enforced by convention + lint):

- `logic/` — pure functions, no I/O, no Date.now(), fully unit-testable.
- `controllers/` — the only place side effects are composed; calls diplomats and logic.
- `diplomat/` — edges: Fastify routes, MCP tool handlers, SQL (Drizzle) queries. Thin; no business logic.
- `adapters/` — pure translation between external representations and internal models.
- `models/` — zod schemas. One schema drives: REST validation, MCP tool inputSchema (the MCP TS SDK is zod-native), SQL row decoding (parse at the boundary), and inferred TS types.

FP conventions: immutable data, function composition over classes, `Result` for expected failures (neverthrow, ADR-001), decode-at-the-boundary everywhere.

## Data model

The as-built **relational schema** (libSQL/Drizzle) is the source of truth in
[`docs/architecture.md` § Relational schema](./architecture.md). Tables: `currencies`, `accounts`,
`credit_cards`, `categories` (self-referential `parent_id` for sub-categories), `merchants`,
`merchant_category` (learned classifier weights), `tags`, `transaction_tags`, `bills`, `transactions`
(with `transactions_fts` FTS5 mirror), `recurring_rules`.

Durable conventions (unchanged across the stack migration):

- **Currency**: every Account/CreditCard references exactly one currency (seed: BRL, USD; extensible).
  Transactions denormalize `currency` at write time so aggregations need no join. Summaries/budgets are
  **always grouped per currency** — no implicit conversion. Cross-currency totals need an FX source (open).
- Amounts in full units of the transaction's currency. Dates as ISO strings; month/year filtering via
  `date >= from AND date < to`.
- `idempotency_key` UNIQUE on transactions — agents retry; duplicate writes must be safe.
- `raw_input` stores the original natural-language text for MCP-created transactions (audit + training).
- Merchant keys are normalized from descriptions (`UBER *TRIP SP` → `uber`) by pure logic; the
  `merchant_category` table accumulates classification knowledge.

The original graph rationale (correlation queries as native traversal) is deferred: at single-user scale
relational + SQL recursive CTEs cover Phase 1–3, and ADR-004 records why the graph DB wasn't worth the
hosted-infra cost for a local-first first release.

## MCP tool design

Principles: tools accept **natural inputs** (names, aliases, relative dates) and the diplomat/adapters resolve them; every write idempotent; destructive actions support `dryRun`; structured errors the agent can self-correct from (e.g. `{ error: "ambiguous_account", candidates: [...] }`). All tool input/output schemas are zod — shared with REST.

### Write tools

| Tool | Notes |
|---|---|
| `create_transaction` | `{ description, amount, type, date?, account?, category?, idempotencyKey }`. Missing category resolved via `merchant_category` classification; returns `{ transaction, classification: { method, confidence } }` so the agent can confirm low-confidence cases with the user. |
| `create_transactions_bulk` | Statement paste / import. Per-item results: created, duplicate-skipped, needs-review. |
| `update_transaction` / `delete_transaction` | Delete requires `confirm: true` after a dry-run echo. User category corrections strengthen `merchant_category` weights. |
| `create_account` / `create_category` / `create_budget` / `create_goal` / `create_recurring` | Name-based refs resolved server-side. |

### Read / analysis tools

| Tool | Notes |
|---|---|
| `search_transactions` | Free text + structured filters (period, category, account, merchant, amount range, tags). |
| `get_spending_summary` | Income, expenses, balance, budget status for a period. |
| `aggregate_spending` | The dashboard primitive: `group_by` (category/account/tag/month/merchant), `period`, `filters`, `metric`. Parameterized SQL — never raw client-supplied SQL. |
| `find_correlations` | Graph-native analysis: co-occurring categories, spending pattern shifts, merchant clusters, recurring candidates. The differentiator tool. |
| `save_view` / `list_views` | Persist a named `aggregate_spending`/`find_correlations` parameterization as a reusable dashboard view (`{ name, tool, params, chartHint }`). |
| `get_budget_status` / `get_goals_progress` | Budget burn and goal tracking. |

### MCP resources & prompts

- Resources: `fintrack://categories`, `fintrack://accounts`, `fintrack://merchants/top` — taxonomy without tool round-trips.
- Prompts: `monthly_review`, `import_statement`, `budget_checkup`.

## Classification — deterministic, learned weights

1. **Merchant match**: normalize description → match `merchants.key` → strongest `merchant_category` row (highest `weight`).
2. **Rules seed**: BR-common merchants pre-seeded as `merchant_category` rows with `origin: rule` (uber/99 → Transporte, ifood → Alimentação, …).
3. **Fallback**: return `category: null, confidence: 0` — the Claude client suggests a category in chat; user confirmation upserts a new/strengthened `merchant_category` row (`origin: history`).

Every user correction increments the row's `weight` (`onConflictDoUpdate`). `classificationMethod` (`rule | history | user | none`) + `confidence` stored on the transaction keep it auditable. No API keys, no per-transaction LLM cost.

## Project structure

```
src/                             # backend lives at repo root
  main.ts                        # Fastify boot: REST plugin + MCP transport
  diplomat/
    http/                        # Fastify route plugins per domain
    mcp/                         # MCP tool/resource/prompt registrations
    db/                          # Drizzle schema + repos (parameterized SQL)
  controllers/                   # one per domain: transactions, accounts, ...
  logic/                         # pure: classification, budgets, recurring, summaries
  adapters/                      # wire ↔ model ↔ db-row translations
  models/                        # zod schemas (single source of truth)
  wire/                          # in/out/db boundary schemas
  common/                        # Result helpers, idempotency, name resolution
docs/
  PLAN.md
  adr/                           # architecture decision records
skills/                          # Claude skills: monthly-review, import-statement, ...
CLAUDE.md                        # dev guidance for AI agents (commands, layer rules)

../fintrack-legacy/              # archived v1 (NestJS/Mongo/React), reference only
```

Config via env (`FINTRACK_DB_KEY` for CI/headless, `PORT`) — see `docs/architecture.md`. No hosted services.

## Infrastructure — none (local-first)

No containers, no external services. The database is a single encrypted libSQL file (`fintrack.db`) opened
in-process; the encryption key lives in the OS keychain (ADR-005), with `FINTRACK_DB_KEY` as a CI/headless
override. `npm run dev` boots REST + MCP and applies migrations + idempotent seed (currencies, BR categories,
merchant rules) on startup. This zero-infra posture is what makes the first MCP package publishable as a
local-only experience (no hosted DB, no auth).

## Development workflow — skills, MCPs, agents, docs

How we'll build this, using the AI tooling already available:

### Skills (engineering plugin — already installed)

| Phase | Skill | Use |
|---|---|---|
| Before each phase | `engineering:architecture` | One ADR per structural decision (Result lib, fatura modeling, FX approach) into `docs/adr/` |
| Design | `engineering:system-design` | API/tool contract reviews before implementing |
| During dev | `engineering:testing-strategy` | Test plan per module; golden-set design for the classifier |
| During dev | `engineering:debug` | Structured debugging sessions |
| Before merge | `engineering:code-review` | Review every diff: layer-boundary violations, SQL injection, missing edge cases |
| Docs | `engineering:documentation` | READMEs, MCP tool contract docs, runbooks |
| Release | `engineering:deploy-checklist` | Pre-release verification once there's a deploy target |

### MCPs

- **GitHub** (engineering plugin): PRs, issues, CI status — connect when the repo goes remote.
- **FinTrack's own MCP**: from Phase 1 exit onward, dogfood it — the app's MCP server is also its best integration test surface. (For ad-hoc DB inspection, the libSQL file opens in any SQLite browser given the key.)

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

### Phase 1 — Skeleton + MCP MVP ✅
Fastify + zod scaffold with diplomat layout; local libSQL + migrations + seed (currencies BRL/USD, BR categories, merchant rules); models and controllers for accounts, categories, transactions; MCP diplomats for `create_transaction`, `search_transactions`, `get_spending_summary`; idempotency; root `CLAUDE.md` + first ADRs. **Exit:** `npm run dev`, then create and query transactions (in BRL or USD) from Claude chat, classified via seeded merchant rows. *(Originally scoped around Neo4j + docker-compose; migrated to local libSQL — ADR-004.)*

### Phase 2 — Classification loop + bulk input ✅ (2026-06-11)
Merchant normalization logic; `merchant_category` weight learning from corrections; `create_transactions_bulk`; credit cards with `bills` lifecycle (open → closed → paid) + recurring rules; transfers (ADR-002), sub-categories, tags, derived balances. **Exit:** paste a statement → classified transactions with confidence flags; corrections improve future classification.

### Phase 3 — Insights + analysis (in progress)
`aggregate_spending`, `find_correlations` (Feature Design 016 — one tool, `analysis`-discriminated, all four
phases done: A `spending_shifts` ✅, D `budget_fit` ✅, C `merchant_concentration` ✅, B `recurring_candidates` ✅
— unblocked by Feature Design 017's recurring-rule merchant key), budgets ✅
(Feature Design 015 —
`create_budget`/`update_budget`/`delete_budget`/`list_budgets`/`get_budget_status`), goals, saved views; MCP
resources + prompts; monthly-review and import-statement skills. **Exit:** "how was my spending vs budget, and
what's driving the change?" answered with composed queries; views persist.

### Phase 4 — Surfaces & hardening
Minimal web frontend rendering saved views; activate owner columns for multi-user groundwork; OFX/CSV importers behind an interface (Open Finance Brasil / Pluggy later); e2e against MCP transport. Multi-user/hosted would also reopen the auth + safety-guard work intentionally deferred for the local-first first release.

## Testing

- `logic/`: plain vitest unit tests — pure functions, no mocks needed. This is where FP pays off.
- Diplomat/db: integration tests against an in-process libSQL DB (Testcontainers where a real engine is needed) — no Docker required for the common path.
- MCP e2e: drive tools through the MCP SDK client — the contract that matters most.
- **REST e2e (gap to close):** the HTTP routes (`src/diplomat/http/routes.ts`) currently have **no** integration
  coverage — only MCP does. Add HTTP-level integration tests (Fastify `inject` against an in-process libSQL DB)
  covering each `/api` route's status codes, validation, and payloads. This becomes load-bearing under **ADR-013**
  (REST is the dashboards' data layer), so it gates that work. Tracked by
  [#21](https://github.com/RafaelFCarneiro/fintrack/issues/21).
- Golden set: ~100 realistic BR transaction descriptions with expected categories; classification accuracy tracked as a regression test.

## Risks & mitigations

- **No ORM-level relation magic**: hand-written joins — mitigated by zod decode-at-boundary (`wire/db`) and keeping all SQL parameterized in `diplomat/db/`.
- **Correlation analysis is wordier in SQL** than the original graph vision — acceptable at single-user scale; recursive CTEs/window functions cover Phase 3.
- **Diplomat discipline** is convention, not framework-enforced — add ESLint import-boundary rules (`logic/` may not import `diplomat/`).
- **Multi-write concurrency (partial-write / TOCTOU):** controller flows that issue multiple sequential
  repo writes are not atomic as a pair, and three concurrent write surfaces now exist (MCP, the default-on REST
  sidecar, scheduled `apply_due_recurring`). The same bug shape recurred twice on PR #83 and was band-aided by a
  one-off reorder. The unit-of-work fix (**ADR-015**) was **rejected before implementation**: a first-mover
  attempt showed the non-atomicity is downstream of a structural problem — the transaction controller owns
  credit-card/bill policy that should live in a credit-card aggregate. **ADR-016** reviews the domain/context
  boundaries first (aggregate ownership over a shared transaction core); concurrency is re-examined afterward,
  scoped to whatever within-aggregate atomicity remains, in a new ADR if still needed.

## Open questions

- ~~Credit card invoices~~ **Decided**: faturas are `bills` rows (`bills.credit_card_id`, `transactions.bill_id`). "Bill" over "Invoice" — invoice is B2B; "bill" matches everyday usage and Nubank's own API naming. Bills carry `close_date`/`due_date`/`status`; card transactions attach to the open bill at write time.
- ~~`Result` library~~ **Decided** (ADR-001): neverthrow.
- ~~Database~~ **Decided** (ADR-004/005/006): local-first encrypted libSQL + Drizzle, key in OS keychain.
- Cross-currency conversion: which FX-rate source (BCB PTAX API is free and official for BRL/USD), and whether to store the rate on the transaction at write time or convert at read time. Until decided, all analytics are per-currency.
