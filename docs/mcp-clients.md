# Connecting FinTrack's MCP to AI clients

FinTrack runs as a **stdio MCP server** by default — the client launches it as a subprocess and speaks JSON-RPC over stdin/stdout. No port, no URL, no bridge. This is the recommended path for all local MCP clients.

HTTP is available as an opt-in (`MCP_TRANSPORT=http`) for multi-client access, REST consumers, or debugging. See the HTTP sections below. Tool contract: `docs/mcp-tools.md`.

---

## Direct stdio (recommended — default)

The client spawns FinTrack directly. No server to start separately; no port conflicts.

### Claude Desktop ✅

In `~/Library/Application Support/Claude/claude_desktop_config.json`, add a top-level `mcpServers` key (newer builds keep app preferences in the same file — don't remove them):

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "@rafaelfcarneiro/fintrack"]
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
      "args": ["-y", "@rafaelfcarneiro/fintrack"]
    }
  }
}
```

MCP tools only appear in **Agent** mode (not Ask/Edit). After config changes: command palette → `MCP: List Servers` → restart fintrack.

### Claude Code (CLI) ✅

```bash
claude mcp add fintrack -- npx -y @rafaelfcarneiro/fintrack
```

Or edit `~/.claude/mcp.json` directly with the same `command`/`args` shape as VS Code above.

---

## HTTP transport (opt-in, `MCP_TRANSPORT=http`)

Start the server explicitly before connecting:

```bash
# from source
MCP_TRANSPORT=http npm run dev

# or from the published package
MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack
```

This serves streamable HTTP MCP at `http://127.0.0.1:3001/mcp` (stateless) **and** the REST API at `/api`.

### Claude Desktop (HTTP mode) ✅ (with bridge)

Desktop only launches stdio servers, so the HTTP endpoint is bridged with `mcp-remote`. In `claude_desktop_config.json`:

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "http://localhost:3001/mcp", "--transport", "http-only"]
  }
}
```

### VS Code / GitHub Copilot (HTTP mode) ✅

Native HTTP support — no bridge. In `.vscode/mcp.json`:

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

Use `127.0.0.1` (not `localhost`) — VS Code's fetch resolves `localhost` to IPv6 `::1`; the backend listens dual-stack (`::`) so either works, but `127.0.0.1` is explicit.

### ChatGPT (HTTP mode, untested — requires tunnel)

ChatGPT's servers connect from the internet: needs a paid plan with Developer Mode (Settings → Apps → Advanced → Developer mode) and an HTTPS tunnel:

```bash
cloudflared tunnel --url http://localhost:3001   # → https://xxx.trycloudflare.com
```

Add connector with URL `https://xxx.trycloudflare.com/mcp`, auth: none. ⚠️ The tunnel exposes the unauthenticated API to anyone with the URL — test only, kill the tunnel after. Permanent exposure needs MCP auth (Phase 4).

### Ollama (HTTP mode, untested — needs a bridge client)

Ollama serves models; it has no MCP client. Use a bridge such as `ollmcp` (`uvx ollmcp`, add server by URL `http://127.0.0.1:3001/mcp`), MCPHost (unmaintained), or LM Studio (GUI, `mcp.json` like VS Code's). Use a strong tool-calling model (qwen3-class or better) — small models fumble tool arguments; that's the model, not the server.

---

## Debugging

```bash
# stdio mode — start the MCP Inspector in HTTP proxy mode pointing at the running server
MCP_TRANSPORT=http npm run dev   # start in HTTP mode
npm run mcp:inspect              # MCP Inspector UI → http://127.0.0.1:3001/mcp

# HTTP mode healthcheck
curl -s http://127.0.0.1:3001/api/health
```
