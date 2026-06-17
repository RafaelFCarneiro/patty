# Connecting FinTrack's MCP to AI clients

This guide covers **HTTP-based** client connections. The default and simplest setup is **stdio** (the client launches FinTrack directly — no port, no bridge); see the README's "Connecting to AI clients". For HTTP, start the backend in HTTP mode — `MCP_TRANSPORT=http npm run dev` (from source) or `MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack` — which serves streamable HTTP MCP at `http://127.0.0.1:3001/mcp` (stateless). Tool contract: `docs/mcp-tools.md`.

## Claude Desktop ✅ working

Desktop only launches stdio servers, so the HTTP endpoint is bridged with `mcp-remote`. In `~/Library/Application Support/Claude/claude_desktop_config.json`, add a top-level `mcpServers` key (newer builds keep app preferences in the same file — don't remove them):

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "http://localhost:3001/mcp", "--transport", "http-only"]
  }
}
```

Fully quit (Cmd+Q) and reopen after editing. New tools require a new chat (tool list is cached per conversation).

## VS Code / GitHub Copilot ✅ working

Native HTTP support — no bridge. Config is committed at `.vscode/mcp.json` (note the root key is `servers`, not `mcpServers`):

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

- MCP tools only appear in **Agent** mode (not Ask/Edit).
- After config changes: command palette → `MCP: List Servers` → restart fintrack.
- Gotcha fixed in `2ff6000`: use `127.0.0.1` (VS Code's fetch resolves `localhost` to IPv6 `::1`); backend listens dual-stack (`::`) since that commit.

## ChatGPT (untested — requires tunnel)

ChatGPT's servers connect from the internet: needs a paid plan with Developer Mode (Settings → Apps → Advanced → Developer mode) and an HTTPS tunnel:

```bash
cloudflared tunnel --url http://localhost:3001   # → https://xxx.trycloudflare.com
```

Add connector with URL `https://xxx.trycloudflare.com/mcp`, auth: none. ⚠️ The tunnel exposes the unauthenticated API to anyone with the URL — test only, kill the tunnel after. Permanent exposure needs MCP auth (Phase 4).

## Ollama (untested — needs a bridge client)

Ollama serves models; it has no MCP client. Use a bridge such as `ollmcp` (`uvx ollmcp`, add server by URL `http://127.0.0.1:3001/mcp`), MCPHost (unmaintained), or LM Studio (GUI, `mcp.json` like VS Code's). Use a strong tool-calling model (qwen3-class or better) — small models fumble tool arguments; that's the model, not the server.

## Debugging any client

```bash
npm run mcp:inspect            # MCP Inspector UI — connect to http://127.0.0.1:3001/mcp
curl -s http://127.0.0.1:3001/api/health   # backend up?
```
