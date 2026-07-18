# CLAUDE.md

Guidance for AI agents working in this repository.

## Project overview

FinTrack v2 is an AI-first personal finance manager. The primary interface is AI chat (Claude clients) talking to the backend's **MCP server**; REST is a secondary surface. Backend: TypeScript, Fastify, zod, libSQL (encrypted local SQLite via `@libsql/client`), Drizzle ORM, diplomat architecture, functional programming style. Full plan: `docs/PLAN.md`. v1 (NestJS/Mongo/React) is archived as functional reference only — never modify it.

## Development setup

```bash
npm install
npm run dev   # stdio MCP server by default (ADR-007), HTTP sidecar (REST /api + /ui dashboards) on by default too
```

The database is a local encrypted libSQL file (`fintrack.db`). On first run the encryption key is generated and stored in the OS keychain (`@napi-rs/keyring`). For CI/headless environments set `FINTRACK_DB_KEY` (64-char hex string) — never commit or log it.

The HTTP sidecar (REST `/api` + `/ui` dashboards) starts automatically alongside stdio — the dashboard experience is a core feature, not opt-in (ADR-013 Decision 7). Set `FINTRACK_HTTP=false` to disable it (stdio-only, no port bound). `MCP_TRANSPORT=http` switches the transport entirely instead (no stdio fallback; a bind failure there is fatal by design). `npm run dev` pins `PORT=3001` for either (package.json); the published package defaults to `PORT=51737` instead — deliberately not a common Node/Fastify dev-server port, to minimize collisions with other software (`docs/architecture.md` § HTTP sidecar). A bind failure for the sidecar (e.g. the port is already in use) is caught and non-fatal — stdio keeps working regardless; this is a resilience fallback, not the normal state.

- REST API: `http://127.0.0.1:3001/api` (from source) / `http://127.0.0.1:51737/api` (published package)
- MCP endpoint (streamable HTTP): `http://127.0.0.1:3001/mcp` (from source) / `http://127.0.0.1:51737/mcp` (published package)
- Run `npx ntl` for an interactive, described list of all scripts.

## Commands

```bash
npm run dev             # tsx watch
npm run build           # tsc (tsconfig.build.json)
npm start               # node dist/main.js
npm run lint            # eslint (style/quality smell rules — part of the gate)
npm test                # vitest run (unit tests under test/unit)
npm run typecheck       # tsc --noEmit (includes tests)
npm run test:integration # in-process libSQL DB, no Docker required
npm run test:all        # unit + integration
npm run mcp:inspect     # MCP Inspector — connect to http://127.0.0.1:3001/mcp
```

Run a single test file: `npx vitest run --config vitest.unit.config.ts test/unit/logic/classify.test.ts`

Tests live under `test/unit/` and `test/integration/` (not colocated). The backend lives at the repo root (`src/`, `package.json`) — there is no `backend/` subfolder.

## Definition of Done (mandatory — verify before EVERY push, initial delivery and each PR-fix push alike)

Quality is delivered, not reviewed in. Before pushing any branch — first cut or a fix addressing review — you MUST run the self-review pass below, fix what it surfaces, and only then push. State the result of each item in the PR description (or the review reply for a fix). "I'll fix it if review catches it" is not acceptable; review is the backstop, not the gate.

**The gate (must be green on every push):**

```bash
npm run lint && npm run typecheck && npm run test:all && npm run build
```

**Self-review pass (do this every time, before the gate):** produce the diff (`git diff origin/main...HEAD`), read every changed hunk, and check it against:

1. **Read the source docs in full, not a summary — mandatory every time, not only for visibly "architectural" changes.** Open `docs/diplomatic-architecture.md`, `docs/functional-core-imperative-shell.md`, and `docs/code-quality.md` themselves before doing items 2-7 below. The condensed bullets elsewhere in this file (Architecture guidance, Agent-level non-negotiables, Documentation map) are a *pointer* to those docs, not a substitute for reading them — a change that only touches composition-root/entrypoint files (e.g. `main.ts`, a new top-level wiring module) still counts as "architecture-related" and still requires this step. Skipping the real file and relying on a derived summary is how violations that are explicit in the source doc (e.g. cross-file literal duplication, covered below) get missed.
2. **Layering** (`docs/architecture.md` dependency table, `docs/diplomatic-architecture.md`, `docs/functional-core-imperative-shell.md`): `logic/` is pure (no I/O, no `diplomat`/`controllers` imports); the domain never imports seed (`diplomat/db/seed`); boundaries are zod-decoded; controllers return `ResultAsync` via `safeTry`; diplomats stay thin; composition-root wiring (e.g. code that imports from more than one `diplomat/*` submodule to wire them together) lives outside `diplomat/*`, not inside it. For a flow already converted under ADR-021 (`createAccount` so far), the controller returns `{ persist, response }` instead of writing — it must not call a repo write method or touch `Db`; only `diplomat/db`'s `withUnitOfWork` does.
3. **Constants over literals** (`docs/code-quality.md`): no bare string/number where a zod `.enum.*` or named constant exists, **and no literal — including log/error message strings, not just domain values — copy-pasted across two or more call sites, even across files.** If a value is used in more than one place, extract a shared constant/function; grep the diff for repeated substrings before calling this item done.
4. **Declarative over imperative** (`docs/code-quality.md` remeda table): no `xs.filter(...)[0]` → use `R.firstBy`/`R.find`; no manual accumulation loop → `R.groupBy`/`countBy`/`sumBy`/`mapValues`; no chained `.filter().map().sort()` → `R.pipe`. Native `map`/`filter` only for single-stage transforms.
5. **Naming & single responsibility** (`docs/code-quality.md`): names don't restate their module; verb+noun; one job per function.
6. **Tests are mandatory.** Any behavior change (`logic/`, `controllers/`, `adapters/`, `diplomat/db/repos/`, MCP tools) ships added/updated tests in the SAME change — success *and* expected-failure paths. A behavior diff with no test diff is incomplete. In the PR, list each behavior change → the test that covers it. (CI enforces this; don't rely on it — author the tests yourself.)
7. **Docs in the same change**: `docs/architecture.md` (structural changes), `docs/mcp-tools.md` (tool changes), this file (data conventions), and the relevant `docs/designs/NNN` status line. When this file's non-negotiables or this Definition of Done change, mirror them into `.github/copilot-instructions.md` in the same change (CLAUDE.md is the source of truth; the two must not drift).

**Independent subagent verification (required for feature-sized changes).** The author is the worst reviewer of their own diff — it's easy to rationalize what you just wrote. For any feature-sized change, after your own self-review and a green gate, dispatch a fresh verification subagent (the `Task` tool) to re-audit the change independently, then fix what it finds before pushing. A change is "feature-sized" if ANY of these hold: it adds or changes an MCP tool; it touches the schema or a migration; it adds or revises an ADR or design doc; or its diff spans multiple layers or roughly five or more files. Small, single-file fixes need only the inline self-review above.

Give the subagent the diff and a verifier brief, not a vague ask. It should: confirm it read `docs/diplomatic-architecture.md`, `docs/functional-core-imperative-shell.md` (for write-path changes), and `docs/code-quality.md` directly (not a summary); read `git diff origin/main...HEAD`; check every hunk against all seven self-review items above and the dependency table in `docs/architecture.md`; confirm each behavior change has a matching test (success + expected-failure); confirm `docs/*` were updated in the same change; and return a concrete list of violations with file:line, not a "looks good". Treat its findings as a blocking checklist. Because it didn't write the code, it catches the constant-over-literal, remeda, and missing-test misses the author's eye skips.

Healthy design iteration (rethinking an approach mid-flight) is welcome and is NOT what this gate targets — it targets avoidable rework: style/remeda/constant misses and missing tests.

## Architecture guidance

Architecture and domain behavior are documented in canonical docs and should not be duplicated here.

Before changing architecture-related code, read:

- `docs/architecture.md` (as-built project architecture, invariants, dependency direction)
- `docs/diplomatic-architecture.md` (core Diplomat concepts) — **read the file itself**, not just the "Diplomat alignment in this project" summary in `docs/architecture.md`
- `docs/functional-core-imperative-shell.md` (the core/shell split — the domain returns effects as data, the shell executes them; canonical/agnostic, mandatory alongside `docs/diplomatic-architecture.md` for any change that adds or touches a write flow)
- `docs/code-style.md` (controller/logic/adapters implementation patterns)
- `docs/code-quality.md` (constants over literals, naming, single responsibility, no magic values) — same rule: read the file itself, this is reinforced as self-review item 1 below, not optional

"Architecture-related" includes composition-root/entrypoint changes (`main.ts`, new top-level wiring modules), not only changes inside `diplomat/`, `controllers/`, or `logic/`.

Agent-level non-negotiables:

- **Diplomatic architecture is non-negotiable.** Follow the layer rules below exactly unless `docs/architecture.md` explicitly states otherwise for a specific case.
- **Constants over string literals.** Zod enums expose `.enum.*` — always use it. Never pass `'mcp'`, `'expense'`, or any other value that has a named constant. See `docs/code-quality.md`.
- **Declarative over imperative.** Prefer remeda (`countBy`, `groupBy`, `anyPass`, `allPass`, `pipe`, `conditional`, `mergeAll`, `firstBy`, …) over manual loops and mutation. See `docs/code-quality.md`.
- **Names don't repeat their module.** A function in `adapters/transactions.ts` is `modelToDb`, not `modelTransactionToDb` — the namespace at the call site provides context. See `docs/code-quality.md`.
- **Code quality principles apply to every line.** Read `docs/code-quality.md` before generating code. Violations will be caught in review.
- Keep `diplomat/*` thin (parse/delegate/translate) and put orchestration in controllers.
- Keep `logic/*` pure (no I/O or runtime state reads).
- Decode external boundaries with zod and keep expected failures on the Result track.
- If behavior changes, update `docs/architecture.md` in the same change.

Layer rules (enforce in review — violations are bugs):

- `logic/` never imports `diplomat/`, `controllers/`, or anything that does I/O.
- `diplomat/` contains no business logic — it parses, delegates, and translates.
- Controllers return `ResultAsync<T, AppError>` (neverthrow) for **expected** failures (unknown account, ambiguous category…); unexpected errors throw and become 500s.
- Decode at the boundary: every external input (HTTP body, MCP args, SQL rows) is zod-parsed before entering the domain.
- Fastify routes: use `reply.send()` consistently — never mix with bare `return` in the same handler, as it causes hard-to-debug double-send issues.

## FP conventions (ADR-001, ADR-003)

This is a quick operational summary for agents. Canonical wording lives in `docs/architecture.md` and `docs/code-style.md`.

One concern per library — don't cross them:

- **zod**: schemas + boundary decoding only.
- **neverthrow**: control flow for fallible operations. Controllers compose via `safeTry` generator pipelines — each `yield*` short-circuits on `err` (Railway-Oriented). Shared combinators: `guard`/`okOr` (`common/result.ts`), entity resolvers (`controllers/resolve.ts`). Controllers return `ResultAsync`; diplomats just `await` them.
- **remeda** ([docs](https://remedajs.com/docs/)): pure data reshaping in `logic/`/`adapters/` (`pipe`, `groupBy`, `sortBy`, `sumBy`, `countBy`, `firstBy`). Use when a transformation has ≥2 stages or needs grouping; native `map`/`filter` is fine for trivial cases.

## Data conventions

This is a quick operational summary for agents. Canonical wording lives in `docs/architecture.md`.

- IDs: `crypto.randomUUID()`; seeded nodes use stable English slugs (`cat-food`, `cat-transport`, …).
- Locale: `settings` table holds `locale` (`en|es|pt`) + `locale_source` (`default|inferred|explicit`). Resolution: `FINTRACK_LOCALE` env → `settings.locale` → `'en'`. Default categories carry a JSON `names` column (`{"pt":"…","es":"…"}`); display names are resolved at read time as `names?.[locale] ?? name` (ADR-009). User categories keep literal names (`names = null`). Seeded translations are authored in `diplomat/db/seed/categories.ts`.
- Currency: BRL and USD seeded. Accounts/cards reference one currency (`currency` FK → `currencies`); transactions carry a denormalized `currency` column. Summaries always group per currency — never convert implicitly.
- Amounts: full units (reais/dollars), positive numbers; `type` (`expense`/`income`) carries the sign.
- Dates: `YYYY-MM-DD` strings; month/year filters become date range conditions in SQL (`date >= from AND date < to`).
- Idempotency: every transaction write uses `UNIQUE(idempotency_key)` + `onConflictDoNothing()`; `rowsAffected === 0` means duplicate — return existing row with `created: false`.
- Classification: `classificationMethod` (`rule|history|user|none`) + `confidence` stored on every transaction; merchant knowledge lives in the `merchant_category` table (`merchant_key`, `category_id`, `weight`, `origin: rule|history`).
- MCP-created transactions store `rawInput` (original natural-language text).
- Credit cards: transactions reference a card (`credit_card_id`) and the cycle's bill (`bill_id`); the `bills` row (fatura) is auto-created `open` based on the card's `closingDay`. `pay_bill` only flips status — never creates a payment transaction (would double-count).
- Recurring: `recurring_rules` rows with `next_due`; materialized by `apply_due_recurring` with stable keys `rec-<ruleId>-<date>`.
- Bulk import: idempotency keys derived from `date+description+amount`; items with confidence < 0.6 are flagged `needs_review`, not blocked.
- Transfers: transactions with `type: 'transfer'` and BOTH `from_account_id` AND `to_account_id` set (ADR-002) — one row for the whole movement. Summary/classification queries MUST exclude `t.type = 'transfer'`. Same-currency only until FX lands.
- Transaction status: `pending | effective`. `effective` = cleared, counts toward balances/summaries. `pending` = expected but not yet real; excluded from balances and summaries; confirmed via `confirm_transaction`. **Default is date-aware**: when `status` is omitted, future-dated transactions default to `pending`, past/present to `effective`; an explicit `status` always wins. Classification ignores status.
- Balances: derived, never stored — `initialBalance + income − expenses + transfers in − transfers out`. **Only `effective` transactions count.** Projection (effective + pending-through-date) is opt-in via `projectedAsOf` on `get_account_balances`.
- SQL queries: always use Drizzle's parameterized API or the `sql` template tag — never interpolate user input into query strings.

## Documentation map (read before generating)

**Taxonomy (keep each doc in its lane).** Canonical concept docs (`docs/diplomatic-architecture.md`, `docs/functional-core-imperative-shell.md`) are **agnostic** — concepts and the obligations to satisfy them, with **no** project nouns, identifiers, library names, ADR references, or status/phase tracking. Project specifics (schema, concrete types, structures), the ADR index, and current-state/next-steps live in `docs/architecture.md`, kept **current-only** (prune replaced concepts — no ghosts). Operational rules live in `docs/code-style.md`/`docs/code-quality.md`. A canonical doc that names a project entity, identifier, ADR, or phase is a taxonomy violation — move it to `docs/architecture.md`. **Check this on any docs change (self-review).**

- `docs/architecture.md` — the system **as built**: relational schema, invariants, layer rules. The source of truth when generating code; if your change alters it, update it in the same change.
- `docs/diplomatic-architecture.md`: The Diplomatic Architecture core concepts.
- `docs/functional-core-imperative-shell.md` — Functional Core / Imperative Shell: what the domain declares as effects (as data) and what the shell executes. Mandatory alongside the Diplomatic Architecture doc for write-flow changes; see `docs/architecture.md` for this project's concrete types and current state.
- `docs/code-style.md` — code style with do/don't examples (safeTry controllers, remeda pipelines, zod-only types). Generated code MUST match these patterns.
- `docs/code-quality.md` — quality principles: constants over literals, naming, single responsibility, no magic values. Read before generating any code.
- `docs/PLAN.md` — roadmap/vision; updated at phase boundaries, may lag the as-built state.
- `docs/adr/` — decisions with rationale; never contradict an accepted ADR without writing a new one.
- `docs/mcp-tools.md` — MCP tool contract. `docs/mcp-clients.md` — client connection guide.

## Process

- Architecture decisions get an ADR in `docs/adr/` (use the engineering:architecture skill).
- Docs are updated in the same change that alters behavior — `docs/architecture.md` for structural changes, `docs/mcp-tools.md` for tool changes.
- New MCP tools must be documented in `docs/mcp-tools.md` with schema, error codes, and an example.
- Commit messages follow Conventional Commits: `type(scope): description`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Use `!` or `BREAKING CHANGE:` footer for incompatible changes.

## Git workflow (branch + PR only)

`main` is **protected — never commit or push directly to it.** All changes land via pull request:

1. Branch off the latest `main`: `git checkout main && git pull && git checkout -b type/short-description` (branch name uses the Conventional Commit type, e.g. `refactor/classification-history`, `docs/contributing-workflow`).
2. Commit on the branch (Conventional Commits), `git push -u origin <branch>`.
3. Open a PR targeting `main`: `gh pr create --base main --fill` (or with an explicit `--title`/`--body`). CI must pass and the PR must be reviewed before merge.
4. After merge, the feature branch is deleted; pull `main` before starting the next branch.

If work was accidentally committed to local `main`, move it before pushing: `git branch <feature>` then `git fetch origin && git reset --hard origin/main && git checkout <feature>`, and continue on `<feature>`.

## Pull request comments

When working on a PR — addressing review feedback, pushing fixes, or responding to comments — always reply to every open review comment on that PR after the work is done. Use `gh api graphql` with `addPullRequestReviewThreadReply` to post replies (the REST replies endpoint is unreliable). Each reply should reference the commit SHA that resolves it so the thread is traceable.

Do this automatically without waiting to be asked.

## Tech debt

When a known trade-off is deliberately deferred during a PR or feature — a performance optimization, a correctness edge case, a refactor — create a **GitHub Issue** to track it. Do not create local markdown files for this purpose.

The issue body should include:
- What the current code does and why it's suboptimal
- The improved approach (with code/query snippet if applicable)
- Why it was deferred
- When it should be tackled (trigger condition or milestone)
- Rough effort estimate

After creating the issue, reference it in the PR description or review thread so the connection is traceable.
