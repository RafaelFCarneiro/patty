# ADR-025: Diplomat edge organization — per-domain registration modules, thin aggregators

**Status:** Accepted · **Date:** 2026-07-26 · **Deciders:** Rafael · A structural/organization decision for the
composition-root edges (`diplomat/mcp`, `diplomat/http`). Sits alongside **ADR-016** (domain/context boundaries)
and the diplomat-layering rules in `docs/canonical/diplomatic-architecture.md` — the same "where does code live" axis, now
applied to the edges. Supersedes the initial framing of this work as a feature design.

## Context

The two diplomat edges have each grown into a single large file:

- `diplomat/mcp/server.ts` — **~1200 lines**: `buildMcpServer` inlines **51** `registerTool` + **6**
  `registerResource` + **3** `registerPrompt` calls, plus shared response helpers.
- `diplomat/http/routes.ts` — **~990 lines**: `buildRouteDefinitions` returns one large `RouteDefinition[]`.

Every new tool or route lands in the same file, so the edges grow monotonically and a domain's surface is
scattered through a 1000-line function. The rest of the codebase is already organized **by domain, mirroring
`controllers/`** (`controllers/account/*`, `controllers/credit-card/*`, …); the edges are the exception.

This is not a capability — there is nothing new to *do*. It is a decision about **how the edge layer is
organized**, and it produces a **convention that constrains all future edge work**. That is an architectural
decision (ADR), not a feature design.

## Decision

**Organize each diplomat edge as per-domain registration modules that mirror `controllers/`; the entrypoint
(`buildMcpServer` / `buildRouteDefinitions`) only aggregates them. Behavior is unchanged — same tools, routes,
resources, prompts, schemas, and handlers, relocated.**

### Shared context objects (remove the long parameter lists)

- **`McpContext`** = `{ deps, version, runEffects, runEffectsSequence, resetLocale }`, built once and passed to
  each `register…` module.
- **`HttpContext`** = `{ deps, version, runEffects, runEffectsSequence }`, passed to each route builder.
- The shared MCP response helpers (`json`, `jsonError`, `fromResult`, `jsonResource`) move to
  `diplomat/mcp/respond.ts` — one implementation for every tool module.

### MCP (`diplomat/mcp/`)

- `tools/<domain>.ts` per controller domain, each exporting `register<Domain>Tools(server, ctx)`
  (`account`, `creditCard`, `transaction`, `transfer`, `budget`, `recurring`, `category`, `tag`, `dashboard`,
  `correlations`, and a `system`/`reference` module for `get_status`/`get_preferences`/`set_locale`/cross-cutting
  lists). A tool lives with the domain whose controller it calls.
- `resources.ts` — `registerResources(server, ctx, openApiDocument)` (few and cross-domain → one file).
- `prompts.ts` — already holds the template text (Design 019); gains `registerPrompts(server, ctx)`.
- `server.ts` — `buildMcpServer` reduces to: construct the server, build `ctx`, call each `register…` in a flat
  list. Aggregation only.

### HTTP (`diplomat/http/`)

- `routes/<domain>.ts` per domain, each exporting `<domain>Routes(ctx): RouteDefinition[]`.
- `buildRouteDefinitions(ctx)` becomes `[...accountRoutes(ctx), ...categoryRoutes(ctx), …]`. `openapi.ts`
  (`mountRoutes`/`buildOpenApiDocument`) is **unchanged** — it still consumes one array.

### The convention (the durable output)

A new MCP tool/resource/prompt or HTTP route lives in the domain module matching its controller; the entrypoint
never inlines a new registration. Recorded in `docs/architecture.md` (diplomat-edge organization) and pointed to
from `CLAUDE.md` (mirrored to `.github/copilot-instructions.md`).

## Options Considered

### A — Leave the edges as single files (rejected)
Monotonic growth; a domain's surface scattered through a 1000-line function; the edges stay the one part of the
tree not organized by domain.

### B — Split by domain, mirroring `controllers/`, thin aggregator (chosen)
| Dimension | Assessment |
| --- | --- |
| Consistency | Edges now mirror `controllers/` like the rest of the tree |
| Locality | A feature's controller + its tool + its route sit together conceptually |
| Aggregator | `server.ts` / `buildRouteDefinitions` shrink to assembly; new work doesn't bloat them |
| Risk | Low — behavior-preserving; the existing integration suites are the proof |
| Cost | A large but mechanical move; a context object per edge |

### C — Split by MCP primitive (all tools one file, all resources another) (rejected)
Groups by mechanism, not by domain — the opposite of how the codebase is reasoned about; a domain's tools would
still be one undifferentiated 800-line file.

## Consequences

- **Behavior-preserving — the integration suites are the correctness proof, unchanged.** `test/integration/mcp/*`
  and `test/integration/http/*` cover essentially every tool/route/resource/prompt; **a diff to any of those test
  files is a smell** that the move altered behavior. No schema, handler, or registration content changes.
- **The entrypoints become thin aggregators**; adding a tool/route no longer touches a 1000-line file.
- **A convention now governs new edge work** (recorded in `docs/architecture.md` + `CLAUDE.md`/copilot) — new
  registrations go in the domain module, not the aggregator.
- **Context objects** (`McpContext`/`HttpContext`) absorb future edge dependencies without churning every module
  signature.
- `openapi.ts` and the route-definition contract are untouched; the OpenAPI document is byte-identical.

## Migration plan (phased — behind the full gate)

1. **MCP** (`refactor/mcp-edge-by-domain`): `respond.ts` + `McpContext`; `tools/<domain>.ts` modules;
   `registerResources`; `registerPrompts`; `server.ts` reduced to aggregation. MCP integration tests pass
   unchanged. `docs/architecture.md` edge-org note.
2. **HTTP** (`refactor/http-routes-by-domain`): `HttpContext`; `routes/<domain>.ts` modules;
   `buildRouteDefinitions` concatenates; `openapi.ts` untouched. HTTP integration tests pass unchanged. Finish
   the architecture note; add the `CLAUDE.md`/copilot one-liner.

## Action Items

1. [x] Review/accept this ADR.
2. [x] Phase 1 — MCP edge split (behavior-preserving; MCP integration tests unchanged).
3. [x] Phase 2 — HTTP routes split (behavior-preserving; HTTP integration tests unchanged).
4. [x] Record the diplomat-edge-organization convention in `docs/architecture.md`; one-line pointer in
   `CLAUDE.md` mirrored to `.github/copilot-instructions.md`.

Each phase is feature-sized (spans many files) → independent verification subagent per diff, charged
specifically to **diff the registered tool names and route paths before vs after** and confirm nothing was
dropped, renamed, or had its schema/handler changed.
