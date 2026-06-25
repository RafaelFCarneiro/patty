# Feature Design 009: `get_status` tool + accurate server version

**Type:** Feature design (a feature + technical assessment) · **Design status:** Accepted ·
**Implementation status:** In progress · **Branch:** `feat/mcp-status` (suggested) ·
**Date:** 2026-06-21 · Additive MCP tool + a server-version fix.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

## Context

There's no way to ask fintrack "what version are you / are you healthy?" **from chat**, and the version it
reports is wrong:

- **MCP protocol already exposes identity + liveness** — neither needs a tool: the `initialize` handshake
  returns `serverInfo { name, version }`, and the spec defines a low-level `ping` request for liveness. A
  client reads version from the handshake; a client pings for health.
- **But the LLM agent and the user-in-chat can only call tools** — they can't read the `initialize` serverInfo
  or send a raw `ping`. So for a conversational, local-first app, a small status *tool* is a legitimate
  convenience (verify the install, report the version, confirm the DB is reachable — useful for dogfooding).
- **The reported version is stale/wrong:** `buildMcpServer` hardcodes `new McpServer({ name: 'fintrack',
  version: '0.1.0' })`, while `package.json` is `0.0.0-development` (semantic-release stamps the real version
  into the *published* package.json at release). So both the handshake `serverInfo` and any status tool would
  report `0.1.0` regardless of the actual build — a real bug.

`get_status` over REST: there is `GET /api/health` (`{status:'ok'}`), but only in **http** mode; the default
**stdio** transport has no HTTP surface, so it's invisible to a normal MCP client.

## Decision

1. **Source the real version from `package.json`** (one place, at the composition root) and thread it into the
   MCP `serverInfo` instead of the literal `'0.1.0'`. In dev this reads `0.0.0-development` (honest); in the
   published package it reads the semantic-release version. Fixes the handshake `serverInfo.version` *and* feeds
   the tool below.
2. **Add a `get_status` MCP tool** returning a small, structured status:
   ```jsonc
   { "name": "fintrack", "version": "1.4.2", "db": "ok", "locale": "pt" }
   ```
   - `version` — the sourced package version (same value as `serverInfo`).
   - `db` — `"ok"` if a trivial reachability query succeeds, else `"error"` (the DB is opened at boot, but the
     check confirms the connection is live and gives the agent a definitive answer).
   - `locale` — the effective active locale (`deps.locale()`), handy for debugging the i18n behavior in chat.
   - No input. Read-only, idempotent, never mutates.
3. **REST mirror:** keep `GET /api/health` as the bare liveness probe; add `GET /api/status` returning the same
   payload as `get_status` (so the richer status is reachable in http mode too). Don't overload `/api/health`.
4. **Protocol-native stays primary.** This tool *complements* — it doesn't replace — `serverInfo`/`ping`; it
   just makes the same facts reachable by a tools-only caller (the agent/user). Documented as such.

## Scope / out of scope

- **In:** version sourced from `package.json` into `serverInfo`; `get_status` MCP tool (`{name, version, db,
  locale}`); a cheap DB reachability check; `GET /api/status` REST mirror; `docs/mcp-tools.md`; tests.
- **Out:** richer telemetry (row counts, uptime, memory), metrics endpoints, auth/readiness vs liveness
  distinction — none needed for a local-first single-user app. (Counts could be a later addition if useful.)

## Options Considered

### A `get_status` tool + version-from-package.json — **chosen**
**Pros:** gives the agent/user an in-chat way to verify version + DB health (tools are the only surface they
have); fixes the stale `serverInfo` version at the same time; tiny and read-only.
**Cons:** a status tool is non-standard MCP surface — acceptable, and framed as a convenience over the
protocol-native handshake/ping.

### Rely only on `initialize` serverInfo + `ping` — rejected (insufficient here)
Correct for a *client*, but the LLM agent and chat user can't access either; they'd have no way to answer "what
version / is it healthy?" So we still fix the version (serverInfo) but add the tool for tool-only callers.

### Reuse/extend `/api/health` only — rejected
HTTP-only; invisible under the default stdio transport. The MCP tool is the surface that matters here.

## Consequences

- **Version sourcing:** resolved once at the composition root (`main.ts`) from `package.json` and passed into
  `buildMcpServer(deps, version)` (and the status controller). Removes the hardcoded `'0.1.0'`.
- **New:** a small `getStatus` controller (`{name, version, db, locale}`); a cheap repo reachability check
  (e.g. `SELECT 1`); the `get_status` MCP tool + `GET /api/status` route; docs.
- **Reuse:** `deps.locale()` for the active locale; the existing `db` handle for the reachability query.
- **Blast radius:** additive — one tool, one tiny controller + repo method, one REST route, and the
  `buildMcpServer` signature gains a `version`. No domain/schema change.

---

## Implementation prompt

> Hand this to a coding agent. Source of truth: this design. Work on branch **`feat/mcp-status`** off `main`;
> `git fetch && git rebase origin/main` first. **Follow the project guidelines — mandatory:** read `CLAUDE.md`
> (esp. the **Definition of Done**), `docs/architecture.md`, `docs/diplomatic-architecture.md`,
> `docs/code-style.md`, `docs/code-quality.md`, and conform (diplomatic layering, `safeTry`/`ResultAsync` or
> plain async as the existing read controllers do, thin diplomats, constants over literals). Skim `src/main.ts`
> (composition root), `src/diplomat/mcp/server.ts` (`buildMcpServer`, the `new McpServer({...})` line),
> `src/diplomat/mcp/stdio.ts`, `src/controllers/summary.ts` (a simple read controller to mirror),
> `src/diplomat/db/driver.ts`, `src/controllers/deps.ts`, `src/diplomat/http/routes.ts`.

### Steps

1. **Version sourcing:** in `main.ts`, read the version from `package.json` (e.g.
   `createRequire(import.meta.url)('../package.json').version`, or `JSON.parse(readFileSync(new
   URL('../package.json', import.meta.url)))` — resolve relative to the entry file so it works under both `tsx
   src/main.ts` and `node dist/main.js`). Pass it into `buildMcpServer(deps, version)`; use it in
   `new McpServer({ name: 'fintrack', version })` instead of the literal. (Dev → `0.0.0-development`; published →
   the real version. That's correct.)
2. **DB reachability:** add a tiny repo method (e.g. on a small `healthRepo`, or an existing repo) that runs a
   parameterized `SELECT 1` and resolves `true`/throws; the controller maps it to `db: 'ok' | 'error'`.
3. **Controller** (`controllers/status.ts`): `getStatus(deps, version)` → `{ name: 'fintrack', version, db, locale }`
   (db via the reachability check, locale via `deps.locale()`). Keep it a thin read.
4. **MCP tool:** register `get_status` (no input; rich `description` noting it complements the protocol
   `initialize`/`ping`) → returns the status JSON. Thread `version` from `buildMcpServer`'s new param.
5. **REST:** add `GET /api/status` returning the same payload; leave `GET /api/health` as-is.
6. **Docs:** add `get_status` (and `/api/status`) to `docs/mcp-tools.md`; note the version now reflects the
   package version.

### Tests
- **Integration** (in-process libSQL): `get_status` returns `name: 'fintrack'`, a non-empty `version`, `db:
  'ok'`, and the current `locale`; after `set_locale('pt')`, `locale` is `pt`. (Don't assert an exact version
  string — assert it's present/non-empty and equals the package version.)
- **Unit** (if the version sourcing is extracted): the resolver returns the `package.json` version.
- **Gate:** `npm run lint && npm run typecheck && npm run test:all && npm run build`.

### Invariants — do not break
- **Read-only:** `get_status` never mutates; no side effects beyond a `SELECT 1`.
- **Version is sourced, never hardcoded** — `serverInfo` and `get_status` report the same package version.
- **Protocol-native primary:** the tool complements `initialize` serverInfo + `ping`; documented as a
  convenience for tool-only callers.
- **Diplomatic layering:** version resolved at the composition root; thin controller; parameterized reachability
  query in `diplomat/db`; thin diplomats; constants over literals.
- **Docs in the same change:** `docs/mcp-tools.md` (`get_status` + `/api/status`).
- **Definition of Done (CLAUDE.md):** self-review pass + gate before every push. Small, single-area change —
  inline self-review suffices.

### Finish
Conventional Commits (`feat(mcp): get_status tool + accurate server version` + `test:`/`docs:`),
`git push -u origin feat/mcp-status`, open a PR targeting `main`. Run the Definition of Done; do not merge;
after CI, reply to review threads with the resolving SHA.

## Deferred follow-up

- Optional richer status (row counts, uptime) if it proves useful for support/debugging.
