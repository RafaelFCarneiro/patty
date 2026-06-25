# ADR-007: stdio as the default MCP transport, HTTP opt-in

**Status:** Accepted · **Date:** 2026-06-17 · Builds on the MCP-first design in `docs/architecture.md`.

## Context

The MCP server has shipped with a single transport: **streamable HTTP** (`diplomat/mcp/route.ts` over
Fastify, bound to `PORT`, default 3001). REST lives on the same Fastify instance. Now that the package is
published (`@rafaelfcarneiro/fintrack`, ADR via the release pipeline) and meant to be run locally as a
personal MCP server, the HTTP-only transport has friction:

1. **Port conflicts.** A fixed HTTP port collides when several MCP servers run on one machine. Managing a
   unique `PORT` per server is manual and easy to get wrong.
2. **Connection ceremony.** HTTP MCP needs the server started separately *and* a client URL configured;
   Claude Desktop additionally needs the `mcp-remote` stdio↔HTTP bridge. Three moving parts for what should
   be one.
3. **The ecosystem default is stdio.** Most local MCP servers are launched by the client over **stdio** —
   the client spawns the process and speaks JSON-RPC over stdin/stdout. No port, no URL, no bridge, and
   no possibility of a port collision.

The domain is already transport-agnostic: `buildMcpServer(deps, version)` in `diplomat/mcp/server.ts` registers the
tools and knows nothing about HTTP. HTTP is just one *edge* wired onto it. Adding stdio is adding a second
edge — a direct fit for the diplomatic architecture (transports are edges; the domain does not move).

## Decision

Support **two** MCP transports, selected by config, with **stdio as the default**:

1. **`MCP_TRANSPORT` config** (`config.ts`), zod enum **`stdio | http`**, default **`stdio`**.
   (`both` is intentionally **out of scope** — see Options. One transport per process keeps logging and
   lifecycle unambiguous; a combined mode can be revisited later if a real need appears.)
2. **`stdio` (default):** build the server and connect a `StdioServerTransport` (new edge
   `diplomat/mcp/stdio.ts`). **Fastify is not started**; there is no HTTP server, no port, no REST.
3. **`http` (opt-in):** current behaviour unchanged — Fastify with REST + streamable HTTP MCP on `PORT`.
4. **`buildMcpServer(deps, version)` stays the single transport-agnostic core.** Both edges connect the same server;
   no tool, controller, logic, model, or repo changes.
5. **stdout is reserved for the protocol in `stdio` mode.** JSON-RPC frames travel over stdout, so **all
   human-facing logging (startup, migration, seed, errors) must go to stderr** in stdio mode. This is the
   single hard correctness rule of this change. In `http` mode, stdout logging remains fine (no protocol
   on stdout).

The published `bin` (`dist/main.js`) therefore defaults to a **native stdio MCP server**: a client can
launch `npx @rafaelfcarneiro/fintrack` directly with no port, no URL, and no `mcp-remote` bridge.

## Options Considered

### Option A — Keep HTTP-only (status quo)
**Pros:** nothing to build; REST always available.
**Cons:** port conflicts; three-part connection ceremony; diverges from the local-MCP norm.

### Option B — stdio default, HTTP opt-in (`stdio | http`) — **chosen**
**Pros:** zero-config, conflict-free default that matches how clients launch local MCP servers; HTTP (and
REST) preserved behind one env var; minimal, additive change that the diplomatic seam already supports.
**Cons:** REST is unavailable in the default mode; logging discipline (stderr) becomes load-bearing.

### Option C — stdio + HTTP simultaneously (`both`)
**Pros:** one process serves a launching stdio client and other HTTP clients at once.
**Cons:** ambiguous logging (stdout must be protocol-only for stdio yet Fastify logs there), two lifecycles
to reconcile, more surface to test — complexity without a current use case. **Deferred**, not adopted.

## Consequences

- **Default UX:** `npx @rafaelfcarneiro/fintrack` is a stdio MCP server. Claude Desktop / VS Code config
  becomes `{ "command": "npx", "args": ["-y", "@rafaelfcarneiro/fintrack"] }` — no port, no bridge. The
  port-conflict problem disappears for the default path.
- **HTTP/REST still available:** set `MCP_TRANSPORT=http` (with `PORT`) for the streamable-HTTP MCP endpoint
  and the REST API — used for multi-client access, REST consumers, or debugging via the MCP Inspector.
- **REST is stdio-mode-absent:** REST is the secondary surface (`docs/architecture.md`); requiring `http`
  mode for it is acceptable and documented.
- **Logging contract:** a small stderr logger replaces direct `console.log`/stdout writes on the startup
  path; in `http` mode Fastify's logger is unaffected. Verified by a stdio integration test that spawns the
  built `bin` and would fail on any stray stdout byte.
- **Diplomatic blast radius:** changes are confined to `config.ts`, `main.ts` (composition switch), and a new
  `diplomat/mcp/stdio.ts`. `buildMcpServer` and the entire domain layer are untouched.
- **Docs:** `docs/mcp-clients.md` gains the direct-stdio client config as the recommended path; `docs/releasing.md`
  notes `MCP_TRANSPORT` and that port concerns apply only to `http` mode.
