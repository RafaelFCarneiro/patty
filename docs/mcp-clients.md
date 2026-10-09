# Connecting FinTrack's MCP to AI clients

FinTrack runs as a **stdio MCP server** by default — the client launches it as a subprocess and speaks JSON-RPC over stdin/stdout. No port, no URL, no bridge needed for chat itself. This is the recommended path for all local MCP clients.

Alongside that, the **HTTP sidecar** (`/api` + `/ui` dashboards) starts automatically by default — the dashboard experience is a core feature, not something you have to opt into (ADR-013 Decision 7). Set `FINTRACK_HTTP=false` to disable it and stay stdio-only with zero ports bound. See "HTTP sidecar (alongside stdio)" below. Separately, `MCP_TRANSPORT=http` switches the *transport itself* to HTTP, for multi-client access, REST consumers, or debugging — see the HTTP sections below. Tool contract: `docs/mcp-tools.md`.

---

## One-command setup

The `setup` subcommand writes the correct config for your agent automatically. It merges idempotently — safe to re-run, existing keys are preserved.

```bash
npx @rafaelfcarneiro/fintrack@latest setup <tool>
```

| Tool argument | Client | Config file written |
|---|---|---|
| `claude-code` | Claude Code CLI | `~/.claude/mcp.json` |
| `claude-desktop` | Claude Desktop | OS-specific path (see below) |
| `copilot` or `vscode` | VS Code / GitHub Copilot | `.vscode/mcp.json` in current directory |
| `antigravity` | Google Antigravity (2.0, CLI, IDE) | `~/.gemini/config/mcp_config.json` |
| `codex` | OpenAI Codex | prints the snippet to paste manually |

Run without arguments for usage and paths:

```bash
npx @rafaelfcarneiro/fintrack@latest setup
```

---

## Direct stdio (recommended — default)

The client spawns FinTrack directly. No server to start separately; no port conflicts.

### Claude Desktop ✅

In `~/Library/Application Support/Claude/claude_desktop_config.json`, add a top-level `mcpServers` key (newer builds keep app preferences in the same file — don't remove them):

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "@rafaelfcarneiro/fintrack@latest"]
  }
}
```

Fully quit (Cmd+Q) and reopen after editing. New tools require a new chat (tool list is cached per conversation).

### VS Code / GitHub Copilot ✅

Commit `.vscode/mcp.json` at the repo root (note the root key is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "fintrack": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@rafaelfcarneiro/fintrack@latest"]
    }
  }
}
```

MCP tools only appear in **Agent** mode (not Ask/Edit). After config changes: command palette → `MCP: List Servers` → restart fintrack.

### Claude Code (CLI) ✅

```bash
claude mcp add fintrack -- npx -y @rafaelfcarneiro/fintrack@latest
```

Or edit `~/.claude/mcp.json` directly with the same `command`/`args` shape as VS Code above.

### Google Antigravity (2.0, CLI, IDE) ✅

Global config at `~/.gemini/config/mcp_config.json` (or workspace-scoped at `.agents/mcp_config.json`):

```json
{
  "mcpServers": {
    "fintrack": {
      "command": "npx",
      "args": ["-y", "@rafaelfcarneiro/fintrack@latest"]
    }
  }
}
```

Antigravity 2.0: Settings → Customizations → Installed MCP Servers → reload.
Antigravity CLI: type `/mcp` at the prompt to open the MCP Manager and reload.
Antigravity IDE: click `...` in the agent panel → MCP Servers → Manage → View raw config.

---

## HTTP sidecar (alongside stdio)

Keep `MCP_TRANSPORT=stdio` (the default — no change to your client config); the HTTP server (`/api` + `/ui`)
starts automatically alongside it on `PORT` (default `51737` for the published package; `npm run dev` pins
`3001` instead — a deliberately uncommon port for the published default, see
[`docs/architecture.md`](../docs/architecture.md#http-sidecar-adr-013-decision-7)). No extra flag needed:

```bash
# from source → :3001
npm run dev

# or from the published package → :51737
npx @rafaelfcarneiro/fintrack@latest
```

Set `FINTRACK_HTTP=false` if you want stdio-only with nothing bound at all. If the sidecar's port is already
taken, it logs an actionable message to stderr and skips starting instead of failing the whole process —
**stdio MCP keeps working regardless**; this is a resilience fallback, not the normal state, and the same chat
session can then help you find and free the port (see `docs/architecture.md` § HTTP sidecar, ADR-013
Decision 7).

The sidecar binds `127.0.0.1` by default (`HOST` overrides it, e.g. `0.0.0.0` inside a container whose port is published on host loopback only) — never the LAN unless you override it. This API has no auth (local-first, ADR-013), so with the default it is
not reachable from other devices on your network, only from this machine; setting `HOST` to a wildcard (`0.0.0.0`/`::`) outside a loopback-only port publish exposes it to the whole network. Use `127.0.0.1` in the URL, not
`localhost` — some resolvers prefer IPv6 (`::1`), which this server does not bind.

## Multiple clients at once (dogfooding)

Stdio servers are spawned **per client connection** (ADR-007): running Desktop and Cowork/Code together, or
reconnecting a client without its first server exiting, means two `fintrack` processes hold two separate
connections to the same `fintrack.db` file. FinTrack makes this graceful rather than fatal (ADR-024) — WAL mode
plus a `busy_timeout` on every connection means a contended writer waits for the lock instead of throwing, and
`runEffects` bounded-retries any `SQLITE_BUSY` that outlives the timeout — but it is still two writers on one
file. For heavy multi-client use, prefer the single shared **HTTP transport** below instead: one process, one
connection, no cross-process contention at all.

## HTTP transport (opt-in, `MCP_TRANSPORT=http`)

Start the server explicitly before connecting:

```bash
# from source → :3001
MCP_TRANSPORT=http npm run dev

# or from the published package → :51737
MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack@latest
```

This serves streamable HTTP MCP at `http://127.0.0.1:51737/mcp` (stateless, published package —
`:3001` from source) **and** the REST API at `/api`.

### Claude Desktop (HTTP mode) ✅ (with bridge)

Desktop only launches stdio servers, so the HTTP endpoint is bridged with `mcp-remote`. In `claude_desktop_config.json`:

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "http://127.0.0.1:51737/mcp", "--transport", "http-only"]
  }
}
```

Running from source instead? Use port `3001`.

### VS Code / GitHub Copilot (HTTP mode) ✅

Native HTTP support — no bridge. In `.vscode/mcp.json`:

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:51737/mcp" } } }
```

Running from source instead (`npm run dev`)? Use port `3001` — this repo's own `.vscode/mcp.json` already does.

Use `127.0.0.1`, not `localhost` — VS Code's fetch can resolve `localhost` to IPv6 `::1`, and the backend binds loopback-only on IPv4 (`127.0.0.1`) by default (`HOST` is the explicit opt-in to anything else), deliberately not the `::`/`0.0.0.0` wildcard, so by default the REST/MCP surface is not reachable from other devices on the LAN (this API has no auth — a wildcard `HOST` removes that protection). `localhost` resolving to `::1` will fail to connect; `127.0.0.1` always works.

### ChatGPT (HTTP mode, untested — requires tunnel)

ChatGPT's servers connect from the internet: needs a paid plan with Developer Mode (Settings → Apps → Advanced → Developer mode) and an HTTPS tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:51737   # → https://xxx.trycloudflare.com (:3001 from source)
```

Add connector with URL `https://xxx.trycloudflare.com/mcp`, auth: none. ⚠️ The tunnel exposes the unauthenticated API to anyone with the URL — test only, kill the tunnel after. Permanent exposure needs MCP auth (Phase 4).

### Ollama (HTTP mode, untested — needs a bridge client)

Ollama serves models; it has no MCP client. Use a bridge such as `ollmcp` (`uvx ollmcp`, add server by URL `http://127.0.0.1:51737/mcp` — `:3001` from source), MCPHost (unmaintained), or LM Studio (GUI, `mcp.json` like VS Code's). Use a strong tool-calling model (qwen3-class or better) — small models fumble tool arguments; that's the model, not the server.

---

## Docker (container, HTTP on `127.0.0.1:51737`)

The image ([README § Docker](../README.md#docker)) always runs the HTTP transport, so every client connects by URL —
`http://127.0.0.1:51737/mcp` — instead of spawning a process. The compose file publishes the port on host loopback only
(`127.0.0.1:51737:51737`); keep it that way — the container serves plain HTTP. Use `127.0.0.1`, not `localhost`.

> A client that reaches FinTrack through a **non-loopback hostname** (a LAN name, a tunnel) needs authentication on — set `PUBLIC_URL`; an auth-disabled instance only answers `127.0.0.1`, `localhost` and `::1` Hosts (and loopback `Origin`s).

> **Temporary limitation — the container's `/mcp` needs a login session.** The container runs with authentication
> `required` (ADR-033), and until personal access tokens ship (Phase 2) `/mcp` accepts only a browser **session
> cookie**, which MCP clients don't carry — every request without one is `401`. **Until then, connect MCP clients
> over stdio** (the npm sections above), which is trusted and unaffected; the dashboards (`/ui`) and REST (`/api`)
> work in a logged-in browser. The table below is what will work once bearer tokens land (Phase 2 adds the
> `Authorization: Bearer ftk_…` header to each). See [`docs/auth.md`](auth.md#temporary-limitation-mcp-over-http-in-the-container).

Each client's HTTP support was checked against its own docs:

| Client | Streamable HTTP | How |
|---|---|---|
| Claude Code | native | `claude mcp add --transport http fintrack http://127.0.0.1:51737/mcp` |
| VS Code / GitHub Copilot | native | `.vscode/mcp.json`: `{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:51737/mcp" } } }` |
| Google Antigravity | native, but the key is **`serverUrl`** (`url`/`httpUrl` are rejected) | `~/.gemini/config/mcp_config.json`: `{ "mcpServers": { "fintrack": { "serverUrl": "http://127.0.0.1:51737/mcp" } } }` |
| OpenAI Codex | native | `codex mcp add fintrack --url http://127.0.0.1:51737/mcp`, or `[mcp_servers.fintrack]` with `url = "http://127.0.0.1:51737/mcp"` in `~/.codex/config.toml` |
| Claude Desktop | `claude_desktop_config.json` only launches stdio servers → local bridge | `mcp-remote` (below) |

Claude Desktop (bridge — same shape as the HTTP-transport section above):

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "http://127.0.0.1:51737/mcp", "--transport", "http-only"]
  }
}
```

Desktop's *Connectors → Add custom connector* flow is for internet-hosted remote servers; it is not documented for
loopback URLs, so use the bridge for the container.

The `npx @rafaelfcarneiro/fintrack setup <tool>` command writes stdio configs only; for the container, edit the config by hand as above.

---

## Debugging

```bash
# MCP Inspector requires HTTP mode (it connects over HTTP, not stdio)
MCP_TRANSPORT=http npm run dev   # start in HTTP mode
npm run mcp:inspect              # MCP Inspector UI → http://127.0.0.1:3001/mcp

# HTTP mode healthcheck
curl -s http://127.0.0.1:3001/api/health
```
