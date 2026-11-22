# Copilot instructions

Guidance for AI agents working in this repository. It holds what every session needs; the details live in the docs it links.

> **`CLAUDE.md` is the source of truth.** This file mirrors it for Copilot; if the two diverge, `CLAUDE.md` wins, and they are changed together in the same change.

## Project overview

PATTY is an AI-first personal finance manager. The primary interface is AI chat (Claude clients) talking to the backend's **MCP server**; REST and the `/ui` dashboards are secondary. Backend: TypeScript, Fastify, zod, libSQL (encrypted local SQLite), Drizzle ORM, diplomat architecture, functional style. v1 (NestJS/Mongo/React) is archived as functional reference — never modify it. Setup, ports, keys and sign-in: `docs/setup.md`. Printed or documented commands are always `npx @rfc0/patty@latest …` (`NPX_COMMAND`).

## Commands

```bash
npm run dev              # tsx watch: stdio MCP server + HTTP sidecar (needs a login: docs/setup.md)
npm run build            # tsc (tsconfig.build.json)
npm run lint             # eslint — part of the gate
npm run format:check     # prettier --check
npm test                 # unit tests (test/unit)
npm run typecheck        # tsc --noEmit, tests included
npm run test:integration # in-process libSQL, no Docker
npm run test:all         # unit + integration
npm run mcp:inspect      # MCP Inspector against /mcp
```

One test file: `npx vitest run --config vitest.unit.config.ts test/unit/logic/classify.test.ts`. Tests live under `test/unit/` and `test/integration/` in a mirrored path, never colocated. The backend is at the repo root (`src/`), not in a subfolder. `npx ntl` describes every script.

## Definition of Done

Run the self-review pass, then the gate, before **every** push — first cut and each review-fix push alike — and state each item's result in the PR description. Review is the backstop, not the gate.

```bash
npm run lint && npm run typecheck && npm run test:all && npm run build && npm run format:check
```

**Self-review pass** — read `git diff origin/main...HEAD` hunk by hunk against:

1. **The source docs, read in full every time** (also for `main.ts` and `src/composition/` changes): `docs/canonical/diplomatic-architecture.md`, `docs/canonical/functional-core-imperative-shell.md`, `docs/canonical/code-quality.md`, `docs/canonical/code-style.md`, `docs/architecture.md` § Conventions in this repo. The bullets below point at them; they do not replace them.
2. **Layering**: the rules below and the dependency table in `docs/architecture.md`.
3. **Constants over literals**: no bare string or number where a zod `.enum.*` or a named constant exists, and no literal — messages included — repeated across two call sites, even across files. Grep the diff for repeated substrings.
4. **Declarative over imperative**, and **function shape** (limits below).
5. **Naming and single responsibility**.
6. **Tests ship in the same change**: every behavior change (`logic/`, `controllers/`, `adapters/`, repos, MCP tools) adds or updates tests for success and expected failure. The PR lists each behavior change → its test.
7. **Docs in the same change**: the docs named in the map below; a change to `CLAUDE.md`'s rules or Definition of Done is mirrored into this file.

**Independent verification (feature-sized changes).** After a green gate, dispatch a fresh verification subagent (`Task`) with the diff and a brief to re-audit it, and fix what it finds before pushing. Feature-sized means any of: an MCP tool added or changed; a schema or migration touched; an ADR or design doc added or revised; a diff across layers or about five or more files. The subagent confirms it read the source docs in item 1 directly, checks every hunk against items 1–7, confirms each behavior change has a test and the docs moved, and returns violations as `file:line`. It also reports pass/fail with evidence on two checks: **engine boundary** (nothing re-implements what `@rfc0/effect-runner` owns — retries, version conflicts, the bus, the persistence contract types; PATTY holds only port bindings and `publishFor`) and **imperative constructs** (no loops, `let` or `.push(` in `logic/`, `controllers/`, `adapters/`, and no workaround such as mutating `forEach`/`reduce` or index writes). Single-file fixes need only the inline pass.

## Rules

### Layering and edges

- `logic/` is pure: no I/O, no runtime-state reads, no import of `diplomat/` or `controllers/`. The domain never imports the seed (`diplomat/db/seed/`).
- `diplomat/*` stays thin: parse, delegate, translate. Orchestration belongs in controllers. Composition-root wiring that touches several `diplomat/*` modules lives in `src/composition/`, not in a diplomat.
- Decode every external input (HTTP body, MCP args, SQL rows) with zod at the boundary; expected failures stay on the Result track.
- Controllers return `ResultAsync<T, AppError>` via `safeTry` pipelines (gather → decide → persist; the decide step is a pure `logic/` function). Unexpected errors throw and become 500s.
- Tools are the one surface every client gets: anything offered as a prompt, resource or skill is also reachable through a tool.
- Edge vocabulary stays at the edge: `models/`, `logic/` and `controllers/` never name a tool, route or CLI command. A domain error whose fix is another operation carries a neutral message and a `Remedy`; each edge turns it into a hint. `ToolName` is lint-restricted to the MCP edge.
- One named definition per MCP tool and HTTP route, in the module for its domain (`diplomat/mcp/tools/<domain>.ts`, `diplomat/http/routes/<domain>.ts`); `server.ts` and `routes.ts` only aggregate. A handler adapts args → model, runs the flow and maps the result in about ten lines.
- A repo queries only its own aggregate's table; correlating aggregates is controller orchestration plus a pure rule in `logic/`. A label-only `LEFT JOIN` is fine. A repo factory only binds the caller's scope; each query is a named function.
- Fastify handlers use `reply.send()` consistently — never mixed with a bare `return`.

### Writes: functional core, imperative shell

- A write flow returns `{ persist, response }` as data and never writes; only the shell's effect runner executes it. Read `docs/write-path.md` before touching any write path.
- The engine is the external `@rfc0/effect-runner`: the runner, retries and version conflicts, the read-version check, the persistence contract and the change bus. Import only its public API. A change it needs is made in its repo, released, then the dependency is bumped here — never forked locally.
- A read that the decision depends on joins the write's conflict set with a version check (`persistence.check`), never by rewriting the row.
- Appliers decide nothing. Every owned-table query and write is scoped to the caller (`user_id`); a controller never sees an unscoped repo or runner. A new owned table needs `user_id`, a scoped repo and applier, a row in the isolation suite (`test/integration/tenancy/`) and a line in the tenancy map.

### Types, style and naming

- Types live in `models/` (the one exception is `controllers/deps.ts`, the ports file); `logic/` and `controllers/` hold functions and constants. Wire contracts live in `wire/`.
- Declarative over imperative with remeda (`R.pipe`, `groupBy`, `countBy`, `sumBy`, `firstBy`, `find`, `anyPass`, `allPass`, `conditional`, `mergeAll`); native `map`/`filter` only for a single-stage transform. `for`/`while`, `let` and `.push(` are lint errors in `logic/`, `controllers/` and `adapters/` — and so are workarounds for them; the shell (`diplomat/`, `composition/`) may be imperative.
- Constants over literals: use a zod enum's `.enum.*` or a named constant, never the bare value.
- Names carry their module's context but do not repeat it: in `adapters/transactions.ts` the function is `modelToDb`, and callers use namespace imports (`import * as transactionAdapters …` → `transactionAdapters.modelToDb`). Verb + noun, one job per function.
- Folders: a domain with more than one file in a layer gets a folder in that layer, and its files drop the folder's name (`logic/demo/plan.ts`, not `logic/demo-plan.ts`). File and folder names are kebab-case.
- Function shape, enforced across `src/**`: at most 40 lines, complexity 10, depth 3, 15 statements; no `switch` of 7+ cases (use a `satisfies Record<Kind, …>` table).
- Comments: a comment stays only when a name, a declarative structure or a test cannot carry the reason. Prefer a test. No ADR or design history in code comments.
- Fallible control flow is neverthrow (`guard`/`okOr`, `safeTry`); schemas and decoding are zod; reshaping is remeda — one concern per library.

### Security

- SQL goes through Drizzle's parameterized API or the `sql` tag; user input is never interpolated.
- Secrets (the database key, passwords, tokens, setup and invite codes) are never logged, printed beyond the one time a flow shows them, written beside the data, or put in a URL or a tool result. The one exception is the single-use invite link (`/ui/access/invite?code=…`): its `code` parameter is redacted from logs and the page sends `Referrer-Policy: strict-origin`.
- User and token management is session-only: never an MCP tool, never an `/api` route, never reachable with a bearer token.

## Data conventions

The ones code most often gets wrong:

- Amounts are positive, in full units; `type` carries the sign. Dates are `YYYY-MM-DD`.
- Only `effective` transactions count toward balances and summaries; balances are derived, never stored.
- A transfer is one row with both accounts; summaries and classification exclude transfers.
- Summaries group per currency and never convert implicitly; rounding uses the currency's own `decimals` (`roundToDecimals`), never a flat 2.
- The idempotency key of a transaction or an investment event is domain-derived (never caller-supplied): sha256 over a JSON array of the write's identity. Recurring (`rec-<ruleId>-<date>`) and bill-payment (`billpay-<billId>`) keys are hand-built and outside that derivation.
- A missing price or rate is `null` and excluded from totals, never 0; holdings are derived from investment events, never stored.

All of them, one line each with a pointer to the invariant that carries the mechanics: `docs/architecture.md` § Data conventions. Changing one means updating it there in the same change.

## Git and PR workflow

`main` is protected — never commit or push to it. Branch off the latest `main` (`type/short-description`), commit with Conventional Commits (`type(scope): description`; types `feat`, `fix`, `docs`, `refactor`, `test`, `chore`), push, and open a PR with `gh pr create --base main`. CI and review gate the merge.

- **Breaking changes**: mark `!` / `BREAKING CHANGE:` only when a user must change something and it cannot be detected for them — an MCP tool or REST contract removed or changed incompatibly, a CLI command or flag removed, or data needing a manual step. A configuration value that now fails at startup with a message saying what to use instead is a `fix:` with a `Note:` paragraph. Check the squash-merge title before merging: it decides the version.
- **PR comments**: after the work, reply to every open review comment with `gh api graphql` `addPullRequestReviewThreadReply` (the REST replies endpoint is unreliable), citing the commit SHA that resolves it. Do it without being asked.
- **Tech debt**: a trade-off deliberately deferred becomes a GitHub Issue (what the code does and why it falls short, the better approach, why deferred, the trigger to tackle it, a rough estimate), referenced from the PR. Never a local markdown file.
- Work accidentally committed to local `main`: `git branch <feature>`, `git fetch origin && git reset --hard origin/main`, `git checkout <feature>`.

## Documentation map

Read the file itself before generating code; update it in the same change that alters what it describes.

| Doc | What it holds |
|---|---|
| `docs/architecture.md` | The system as built: schema, invariants, layer rules, § Data conventions, § Conventions in this repo (libraries, lint rules, folder and test layout). Keep it current-only. |
| `docs/canonical/*.md` | Agnostic principles — diplomatic architecture, functional core / imperative shell, code quality, code style. No project names, identifiers, libraries or ADR references in them. |
| `docs/write-path.md` | Write-path mechanics: effect runner, appliers, outcomes, per-flow notes. |
| `docs/setup.md` | Running from source: ports, key, sign-in in development, Docker, demo. |
| `docs/auth.md`, `docs/auth-flows.md` | Operator guide to authentication, the CLI (`setup`, `login`, `users`, `key`, `db`) and the sign-in flows. |
| `docs/demo.md` | The sample-data demo instance. |
| `docs/mcp-tools.md`, `docs/mcp-clients.md` | MCP tool contract (every new tool: schema, error codes, example); connecting clients. |
| `docs/ui.md`, `docs/releasing.md` | The `/ui` surface; release and distribution. |
| `docs/adr/`, `docs/designs/` | An ADR is a cross-cutting, hard-to-reverse decision (write it with the `engineering:architecture` skill); never contradict an accepted one without a new one. A feature (a capability and how it is built) gets a design in `docs/designs/` (format in its README); its status line moves with its change. |
