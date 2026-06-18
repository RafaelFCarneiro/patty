# CLAUDE.md

Guidance for AI agents working in this repository.

## Project overview

FinTrack v2 is an AI-first personal finance manager. The primary interface is AI chat (Claude clients) talking to the backend's **MCP server**; REST is a secondary surface. Backend: TypeScript, Fastify, zod, libSQL (encrypted local SQLite via `@libsql/client`), Drizzle ORM, diplomat architecture, functional programming style. Full plan: `docs/PLAN.md`. v1 (NestJS/Mongo/React) is archived in the sibling repo folder `../fintrack-legacy` as functional reference only — never modify it.

## Development setup

```bash
npm install
npm run dev   # REST + MCP on http://localhost:3001
```

The database is a local encrypted libSQL file (`fintrack.db`). On first run the encryption key is generated and stored in the OS keychain (`@napi-rs/keyring`). For CI/headless environments set `FINTRACK_DB_KEY` (64-char hex string) — never commit or log it.

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
npm run test:integration # in-process libSQL DB, no Docker required
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

- IDs: `crypto.randomUUID()`; seeded nodes use stable slugs (`cat-transporte`).
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
- Transaction status: `pending | effective` (default `effective`). `effective` = cleared, counts toward balances/summaries. `pending` = expected but not yet real; excluded from balances and summaries; confirmed via `confirm_transaction`. Status is **explicit** — never derived from the date. Classification ignores status.
- Balances: derived, never stored — `initialBalance + income − expenses + transfers in − transfers out`. **Only `effective` transactions count.** Projection (effective + pending-through-date) is opt-in via `projectedAsOf` on `get_account_balances`.
- SQL queries: always use Drizzle's parameterized API or the `sql` template tag — never interpolate user input into query strings.

## Documentation map (read before generating)

- `docs/architecture.md` — the system **as built**: relational schema, invariants, layer rules. The source of truth when generating code; if your change alters it, update it in the same change.
- `docs/diplomatic-architecture.md`: The Diplomatic Architecture core concepts.
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
