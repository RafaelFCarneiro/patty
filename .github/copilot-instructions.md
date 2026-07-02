# Copilot instructions

Guidance for AI agents working in this repository.

> **`CLAUDE.md` is the source of truth.** This file mirrors its non-negotiables for Copilot; if the two ever
> diverge, `CLAUDE.md` wins, and they must be kept in sync in the same change. The canonical depth lives in
> `docs/` (linked below).

## Project overview

FinTrack v2 is an AI-first personal finance manager. Backend: TypeScript, Fastify, zod, libSQL
(encrypted local SQLite) + Drizzle ORM, diplomatic architecture, functional programming style.

The backend lives at the repo root (`src/`, `package.json`) — there is no `backend/` subfolder.
Tests live under `test/unit/` and `test/integration/` (not colocated).

## Before generating any code

Read these docs — they are the source of truth. Do not guess patterns from the code alone, and do not
substitute a condensed summary (in this file or in `docs/architecture.md`) for reading the file itself.

- `docs/diplomatic-architecture.md` — the core architectural pattern. Non-negotiable. Read the file itself, not
  just the "Diplomat alignment in this project" summary in `docs/architecture.md`.
- `docs/architecture.md` — as-built relational schema, layer rules, invariants, dependency table.
- `docs/code-style.md` — do/don't examples for controllers, logic, adapters, zod, remeda.
- `docs/code-quality.md` — quality principles: constants over literals, naming, single responsibility. Read the
  file itself — this is reinforced as self-review item 1 below, not optional.
- `docs/adr/` — accepted architectural decisions; never contradict one without a new ADR.

"Architecture-related" (i.e. requires the above) includes composition-root/entrypoint changes (`main.ts`, a new
top-level wiring module), not only changes inside `diplomat/`, `controllers/`, or `logic/`.

## Definition of Done (mandatory — verify before EVERY push, initial delivery and each PR-fix push alike)

Quality is delivered, not reviewed in. Before pushing any branch — first cut or a review fix — run the
self-review pass below, fix what it surfaces, and only then push. State the result in the PR description (or the
review reply). "I'll fix it if review catches it" is not acceptable; review is the backstop, not the gate.

**The gate (must be green on every push):**

```bash
npm run lint && npm run typecheck && npm run test:all && npm run build
```

**Self-review pass (every time, before the gate):** produce the diff (`git diff origin/main...HEAD`), read every
changed hunk, and check it against:

1. **Read the source docs in full, not a summary — mandatory every time, not only for visibly "architectural"
   changes.** Open `docs/diplomatic-architecture.md` and `docs/code-quality.md` themselves before doing items 2-7
   below. The condensed bullets in "Before generating any code" above are a *pointer*, not a substitute — a
   change that only touches composition-root/entrypoint files (e.g. `main.ts`, a new top-level wiring module)
   still counts as "architecture-related" and still requires this step. Skipping the real file and relying on a
   derived summary is how violations that are explicit in the source doc (e.g. cross-file literal duplication,
   covered below) get missed.
2. **Layering** (`docs/architecture.md` dependency table, `docs/diplomatic-architecture.md`): `logic/` is pure
   (no I/O, no `diplomat`/`controllers` imports); the domain never imports seed (`diplomat/db/seed`); boundaries
   are zod-decoded; controllers return `ResultAsync` via `safeTry`; diplomats stay thin; composition-root wiring
   (code that imports from more than one `diplomat/*` submodule to wire them together) lives outside `diplomat/*`.
3. **Constants over literals** (`docs/code-quality.md`): no bare string/number where a zod `.enum.*` or named
   constant exists, **and no literal — including log/error message strings, not just domain values — copy-pasted
   across two or more call sites, even across files.** If a value is used in more than one place, extract a
   shared constant/function; grep the diff for repeated substrings before calling this item done.
4. **Declarative over imperative** (`docs/code-quality.md` remeda table): no `xs.filter(...)[0]` → use
   `R.firstBy`/`R.find`; no manual accumulation loop → `R.groupBy`/`countBy`/`sumBy`/`mapValues`; no chained
   `.filter().map().sort()` → `R.pipe`. Native `map`/`filter` only for single-stage transforms.
5. **Naming & single responsibility** (`docs/code-quality.md`): names don't restate their module; verb+noun; one
   job per function.
6. **Tests are mandatory.** Any behavior change (`logic/`, `controllers/`, `adapters/`, `diplomat/db/repos/`, MCP
   tools) ships added/updated tests in the SAME change — success *and* expected-failure paths. A behavior diff
   with no test diff is incomplete; CI fails it (`scripts/check-tests-changed.mjs`). List each behavior change →
   its covering test in the PR.
7. **Docs in the same change**: `docs/architecture.md` (structural), `docs/mcp-tools.md` (tool changes),
   `CLAUDE.md`/this file (conventions), and the relevant `docs/designs/NNN` status line.

**Independent re-review for feature-sized changes.** The author is the worst reviewer of their own diff. For any
feature-sized change — a new/changed MCP tool, a schema/migration, a new/revised ADR or design doc, or a diff
spanning multiple layers or ~5+ files — do a second, independent pass over the *full* diff against all seven items
above before pushing (a fresh review, not a glance, and confirm the source docs were actually opened, not just
summarized), and fix what it finds. Small single-file fixes need only the inline self-review. (CLAUDE.md
dispatches a verification subagent for this; in Copilot, do the equivalent fresh end-to-end pass.)

Healthy design iteration (rethinking an approach mid-flight) is welcome and is NOT what this gate targets — it
targets avoidable rework: style/remeda/constant misses and missing tests.

## Non-negotiables

- **Diplomatic architecture** — diplomats (MCP/HTTP) parse and delegate; controllers orchestrate; `logic/` is
  pure; `adapters/` translates between layers. Never mix these concerns. The only exception is when
  `docs/architecture.md` explicitly documents a deviation.
- **Seed isolation (ADR-008)** — seed data (currencies, default categories, merchant rules) lives only in
  `src/diplomat/db/seed/`, consumed solely by `bootstrap.ts`. The domain (`models/`/`logic/`/`controllers/`)
  never imports seed, and every feature must work on an empty (unseeded) DB.
- **Localized content on the entity (ADR-009)** — dynamic content (e.g. category names) is localized on the row
  (`names?.[locale] ?? name`), not via a translation catalog. Catalogs are only for static UI chrome.
- **Constants over string literals** — zod enums expose `.enum.*`; always use it. Never write `source: 'mcp'`
  when `TransactionSource.enum.mcp` exists. Never repeat a magic string or number — name it.
- **Declarative over imperative** — prefer remeda (`countBy`, `groupBy`, `anyPass`, `allPass`, `pipe`,
  `conditional`, `mergeAll`, `firstBy`, …) over manual loops and mutation. See `docs/code-quality.md`.
- **Names don't repeat their module** — a function in `adapters/transactions.ts` is `modelToDb`, not
  `modelTransactionToDb`; the call site (`transactionAdapters.modelToDb`) supplies context. Use namespace imports
  when names would collide.
- **Code quality** — every line follows `docs/code-quality.md`: single responsibility, clear naming, no magic
  values, no premature abstraction, consistency with existing patterns.

## Layer rules

- `logic/` never imports `diplomat/`, `controllers/`, or anything that does I/O; the domain never imports
  `diplomat/db/seed`.
- `diplomat/` contains no business logic — it parses, delegates, and translates.
- Controllers return `ResultAsync<T, AppError>` (neverthrow) for expected failures; unexpected errors throw.
- Every external input (HTTP body, MCP args, SQL rows) is zod-parsed before entering the domain.
- Boundary adaptation lives in `adapters/`: `wireInToModel` inbound, `modelToWireOut` outbound,
  `modelToDb`/`dbToModel` for persistence.

## FP conventions

- **zod**: schemas + boundary decoding only.
- **neverthrow**: `safeTry` generator pipelines in controllers — each `yield*` short-circuits on error.
  Guards: `guard(condition, error)` and `okOr(nullable, error)` from `common/result.ts`.
- **remeda** ([docs](https://remedajs.com/docs/)): pure data reshaping in `logic/` and `adapters/` when ≥2 stages
  or grouping is needed.

## Process

- Commit messages follow Conventional Commits: `type(scope): description`.
- Docs updated in the same change that alters behavior (`docs/architecture.md` for structural changes,
  `docs/mcp-tools.md` for MCP tool changes).
- New MCP tools are documented in `docs/mcp-tools.md` with schema, error codes, and an example.
- Architecture decisions get an ADR in `docs/adr/`; feature designs go in `docs/designs/NNN` with an embedded
  implementation prompt + status line.
- Deferred trade-offs go to GitHub Issues, not local markdown files.

## Git workflow (branch + PR only)

`main` is **protected — never commit or push directly to it.** Every change lands via pull request:

1. Branch off latest `main`: `git checkout main && git pull && git checkout -b type/short-description` (name uses
   the Conventional Commit type).
2. Commit on the branch, `git push -u origin <branch>`, then `gh pr create --base main --fill`.
3. CI must pass and the PR must be reviewed before merge.
4. If work was accidentally committed to local `main`, move it: `git branch <feature> && git fetch origin &&
   git reset --hard origin/main && git checkout <feature>`, then continue on `<feature>`.

## Pull request comments

When addressing review feedback, reply to every open review thread after the work is done, referencing the commit
SHA that resolves it (use `gh api graphql` with `addPullRequestReviewThreadReply`). Do this automatically.
