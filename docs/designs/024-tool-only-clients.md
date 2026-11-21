# Feature Design 024: Tool-only clients

**Type:** Feature design · **Design status:** Accepted · **Implementation status:** Done on
`feat/tool-only-clients` (pending merge) · **Date:** 2026-11-21 · Extends ADR-025 (one named definition per tool, resource and
prompt) and Feature Designs 018 (reference resources), 019 (workflow prompts) and ADR-013/027 (dashboards).

## Context

PATTY offers an AI client more than tools: the `patty://openapi` resource and the reference resources (Feature Design
018), the guided-workflow prompts (019), and the `dashboard-building` skill that `setup` installs next to the client's
configuration. A client that talks to PATTY through a **bridge that forwards tools only** — a remote agent in a
session that receives the server's tools and nothing else — never sees any of them. Prompts, resources and installed
skills do not arrive.

That agent can call `save_dashboard`, but cannot do what the tool's description told it to: read `patty://openapi` for
the contract, follow the skill's checklist, or run the `refresh_quotes` prompt. It also has no REST route for the
holdings (`get_portfolio`, `list_assets`, `list_investment_events` are MCP-only), so the dashboard it builds has no
`/api` endpoint to fetch an investments view from.

## Decision

**Tools are the one surface every client gets: anything offered as a prompt, resource or skill is also reachable
through a tool.** Prompts, resources and skills stay (clients that support them keep their ergonomics); each gains a
tool that returns the same content from the same source.

1. **`get_api_contract`** (read-only). No input: a compact index of every `/api` route — method, path, summary, the
   query and body parameter names, the response type — a few KB, generated from the OpenAPI document, which is
   generated from `buildRouteDefinitions`. With `path` (and optionally `method`): that route's full request and
   response schema, `$ref`s resolved. An unknown path is a validation error that lists the close matches. The route
   array stays the single source of truth; `patty://openapi` and `GET /api/openapi.json` are unchanged.
2. **`get_dashboard_guide`** (read-only). Returns `ui/guides/dashboard-building.md` from the installed package, the
   one source, read and cached like the `ui/` files. Its first step reads the contract with `get_api_contract` (the
   index, then each route it uses); the resource and the REST document stay as alternatives.
3. **`get_workflow`** (read-only). `name` (a `PromptName`) plus that prompt's own arguments returns the messages the
   MCP prompt returns, from the same builder (the prompt's handler), so no text is copied; with no `name` it lists the
   workflows with their descriptions and argument names.
4. **Holdings REST reads**, thin over the existing controllers: `GET /api/portfolio` (as `get_portfolio`),
   `GET /api/assets` (`list_assets`), `GET /api/investment-events` (`list_investment_events`). Read scope, tenancy as
   the tools, in the OpenAPI document. Holdings writes stay MCP-only for now.
5. **Descriptions point at the tools.** `save_dashboard` says to call `get_dashboard_guide` and `get_api_contract`
   first; each prompt's description names its `get_workflow` call; the tools around quotes mention
   `get_workflow({ name: "refresh_quotes" })`.
6. **The skills become pointers.** `skills/dashboard-building/SKILL.md` and `skills/patty-tour/SKILL.md` keep their
   name, description and trigger; the body is a few lines saying to call `get_dashboard_guide` (or
   `get_workflow({ name: "tour" })`). The full guide moves to `ui/guides/`, where the tool reads it. `setup claude-code`
   installs the pointers into `~/.claude/skills/patty-dashboard/` and `patty-tour/`, only when absent or when the file
   is PATTY's own earlier copy (a marker comment); `setup claude-code --remove-skills` takes them out. Adding them to a
   Claude account (Desktop, claude.ai, Cowork) is manual and documented in `docs/mcp-clients.md`.
7. **The rule is enforced.** `diplomat/mcp/tool-paths.ts` maps every prompt (to `get_workflow`) and every resource
   (`patty://openapi` to `get_api_contract`, each data resource to its `list_*` tool). A unit test walks the registered
   prompts and resources and fails unless each has a registered tool path.
   The table lives at the MCP edge, not in `models/`: it names tools, and tool names are the edge's vocabulary
   (`ToolName` is lint-restricted to `diplomat/mcp`).
   Two data resources had no tool: `patty://currencies` and `patty://merchants/top`. They get `list_currencies` and
   `list_top_merchants`, thin over the controllers the resources already call.

## Options

- **Make the bridge forward prompts and resources.** Not ours to change: the bridge is a client of the protocol, and
  every future bridge would have the same gap. A tool is what every client is guaranteed to get.
- **Put the contract in the dashboard tool's description.** Several KB on every `tools/list`, loaded by clients that
  never build a dashboard. A separate tool is read on demand.
- **Return the whole OpenAPI document from a tool.** Over 600 KB for a client that needs three routes. The index plus a
  per-route detail is what the skill's first step needs, and the full document stays one call away on the resource.
- **Copy the skill's text into the tool's source.** A second copy that drifts. The tool reads the packaged file.
- **A `get_workflow` that re-renders the prompts' text.** Copied text. It calls the prompt's own handler.
- **Serve the guide through the MCP Skills extension instead** (`io.modelcontextprotocol/skills`, SEP-2640, Final in
  September 2026): the server lists its skills and the client loads them, with nothing installed by hand. Not yet a
  replacement: it serves skill files through `resources/read`, which a tools-only bridge does not forward; no Claude
  client supports it yet; and it needs protocol revision 2026-07-28 in the SDK. Kept as a later addition (Plan step 8),
  next to the tool path, never instead of it.

## Plan

1. [x] Design 024 (this document).
2. [x] `get_api_contract`: the index and the route detail over the OpenAPI document, `McpContext` carrying the document.
3. [x] `get_dashboard_guide`; the guide moves to `ui/guides/`, the skills become pointers, `setup claude-code` installs
       them (`--remove-skills`).
4. [x] `get_workflow`, the prompts' handlers as the one builder; descriptions name the tool.
5. [x] `GET /api/portfolio`, `/api/assets`, `/api/investment-events`; OpenAPI snapshot, tenancy rows.
6. [x] `list_currencies`, `list_top_merchants`; `tool-paths.ts` and its test; the rule in CLAUDE.md.
7. [x] Tests, the MCP surface snapshot, docs.
8. [ ] Later: serve the dashboard guide (and the tour) through the MCP Skills extension as
       `skill://dashboard-building/SKILL.md`, from the same `ui/guides/` source, once the MCP SDK supports protocol
       revision 2026-07-28 and a Claude client supports the extension. The tools stay; the installed pointer skills can
       go once the clients that load them discover the served ones.

## Implementation prompt

Implement the feature in this document, in the Plan's order, on `feat/tool-only-clients`. Read `docs/architecture.md`
(§ Tool surface, § Conventions in this repo) and the canonical docs first (CLAUDE.md).

- The contract (`logic/api-contract.ts`, pure) derives from `buildOpenApiDocument(buildRouteDefinitions(…))`, never from a hand-written list;
  `diplomat/mcp` importing the builders from `diplomat/http` is the documented exception.
- `get_workflow` calls the prompt definition's own `handle`; no prompt text is duplicated.
- The guide is read from the installed `ui/guides/` folder (resolved from the module, cached on success only); the build
  must ship `ui/` and `skills/` (without `evals`).
- The three holdings routes parse their query with a wire schema, call the controller the tool calls and send the
  result; each has a tenancy row.
- Every tool: schema, error codes and an example in `docs/mcp-tools.md`; tests for success and the expected failure.
- Rule: a unit test over `promptDefinitions` and `resourceDefinitions` fails for a prompt or resource without a tool.

### Finish (every push)
Run the Definition of Done (CLAUDE.md): the self-review pass + the gate
(`lint && typecheck && test:all && build && format:check`), and report the result before pushing. Feature-sized: also
run the independent verification subagent.
