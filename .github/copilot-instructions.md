# Copilot instructions

Guidance for AI agents working in this repository.

## Project overview

FinTrack v2 is an AI-first personal finance manager. Backend: TypeScript, Fastify, zod, libSQL
(encrypted local SQLite) + Drizzle ORM, diplomatic architecture, functional programming style.

The backend lives at the repo root (`src/`, `package.json`) — there is no `backend/` subfolder.

## Before generating any code

Read these docs — they are the source of truth. Do not guess patterns from the code alone.

- `docs/diplomatic-architecture.md` — the core architectural pattern. Non-negotiable.
- `docs/architecture.md` — as-built relational schema, layer rules, and invariants.
- `docs/code-style.md` — do/don't examples for controllers, logic, adapters, zod, remeda.
- `docs/code-quality.md` — quality principles: constants over literals, naming, single responsibility.

## Non-negotiables

These are hard rules. Violations will be rejected in review.

- **Diplomatic architecture** — diplomats (MCP/HTTP) parse and delegate; controllers orchestrate;
  `logic/` is pure; `adapters/` translates between layers. Never mix these concerns.
  The only exception is when `docs/architecture.md` explicitly documents a deviation.

- **Constants over string literals** — zod enums expose `.enum.*`; always use it.
  Never write `source: 'mcp'` when `TransactionSource.enum.mcp` exists.
  Never repeat a magic string or number — name it.

- **Declarative over imperative** — prefer remeda (`countBy`, `groupBy`, `anyPass`, `allPass`,
  `pipe`, `conditional`, `mergeAll`, `firstBy`, …) over manual loops and mutation.
  See `docs/code-quality.md` for the full reference table.

- **Names don't repeat their module** — a function in `adapters/transactions.ts` is named
  `modelToDb`, not `modelTransactionToDb`. The namespace at the call site (`transactionAdapters.modelToDb`)
  already provides context. When names would collide across modules, use namespace imports.

- **Code quality** — every line must follow `docs/code-quality.md`: single responsibility,
  clear naming, no magic values, no premature abstraction, consistency with existing patterns.

## Layer rules

- `logic/` never imports `diplomat/`, `controllers/`, or anything that does I/O.
- `diplomat/` contains no business logic — it parses, delegates, and translates.
- Controllers return `ResultAsync<T, AppError>` (neverthrow) for expected failures; unexpected errors throw.
- Every external input (HTTP body, MCP args, SQL rows) is zod-parsed before entering the domain.
- Boundary adaptation lives in `adapters/`: `wireInToModel` inbound, `modelToWireOut` outbound, `modelToDb`/`dbToModel` for persistence.

## FP conventions

- **zod**: schemas + boundary decoding only.
- **neverthrow**: `safeTry` generator pipelines in controllers — each `yield*` short-circuits on error.
  Guards: `guard(condition, error)` and `okOr(nullable, error)` from `common/result.ts`.
- **remeda** ([docs](https://remedajs.com/docs/)): pure data reshaping in `logic/` and `adapters/` when ≥2 stages or grouping is needed.

## Process

- Commit messages follow Conventional Commits: `type(scope): description`.
- Docs updated in the same change that alters behavior (`docs/architecture.md` for structural changes, `docs/mcp-tools.md` for MCP tool changes).
- Deferred trade-offs go to GitHub Issues, not local markdown files.

## Git workflow (branch + PR only)

`main` is **protected — never commit or push directly to it.** Every change lands via pull request:

1. Branch off latest `main`: `git checkout -b type/short-description` (name uses the Conventional Commit type).
2. Commit on the branch, `git push -u origin <branch>`, then `gh pr create --base main --fill`.
3. CI must pass and the PR must be reviewed before merge.
4. If work was accidentally committed to local `main`, move it: `git branch <feature> && git reset --hard origin/main`, then continue on `<feature>`.
