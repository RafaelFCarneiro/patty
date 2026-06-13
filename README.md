# FinTrack v2

AI-first personal finance manager. The primary interface is natural language through an MCP server — connect it to Claude or VS Code Copilot and talk to your finances directly. REST is a secondary surface.

**What's built:** transactions (expense/income/transfer), accounts, credit cards & bills, recurring rules, bulk import, auto-classification by merchant, and tags. Summaries group per currency; amounts are never converted implicitly.

Stack: TypeScript · Fastify · zod · neverthrow · Neo4j · Docker Compose.

---

## Quick start

```bash
npm install
npm run infra:up:db   # start Neo4j via Docker
npm run dev           # REST + MCP on http://localhost:3001
```

| Endpoint | URL |
|---|---|
| MCP (streamable HTTP) | `http://localhost:3001/mcp` |
| REST API | `http://localhost:3001/api` |
| Neo4j browser | `http://localhost:7474` · neo4j / fintrack123 |

Or run everything containerized: `npm run infra:up`.

Run `npx ntl` for an interactive, described list of all scripts.

---

## Connecting to AI clients

The backend must be running before connecting any client.

### Claude Desktop

Claude Desktop only supports stdio MCP servers, so the HTTP endpoint is bridged with `mcp-remote`. Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
"mcpServers": {
  "fintrack": {
    "command": "npx",
    "args": ["-y", "mcp-remote@latest", "http://localhost:3001/mcp", "--transport", "http-only"]
  }
}
```

Fully quit (Cmd+Q) and reopen. New tools appear only in new conversations (tool list is cached per chat).

### Claude Code (CLI)

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "fintrack": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "http://localhost:3001/mcp", "--transport", "http-only"]
    }
  }
}
```

### VS Code / GitHub Copilot

Native HTTP MCP support — no bridge needed. A config is already committed at [`.vscode/mcp.json`](.vscode/mcp.json):

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

> **Note:** use `127.0.0.1`, not `localhost` — VS Code resolves `localhost` to IPv6 `::1`.

Tools only appear in **Agent** mode (not Ask/Edit). After config changes: Command Palette → `MCP: List Servers` → restart fintrack.

Full connection guide (ChatGPT, Ollama, debugging): [`docs/mcp-clients.md`](docs/mcp-clients.md).

---

## Sample usage

Once connected, talk to Claude naturally. A few examples:

**Log a transaction**
> "Paguei 32,50 de Uber ontem"

**Bulk import a statement**
> "Here's my Nubank statement for May: [paste]"

**Monthly summary**
> "What did I spend in June? Break it down by category."

**Tag and search**
> "Tag last week's restaurant transactions as 'work-dinner', then show me everything tagged work-dinner this month."

**Credit card bill**
> "What's on my Itaú card bill for June? Mark it as paid."

**Recurring rule**
> "I pay R$59 for Spotify every month on the 10th. Set that up as a recurring expense."

---

## Testing

```bash
npm test                  # unit tests
npm run test:integration  # MCP integration tests (isolated ephemeral Neo4j — wiped after each run)
npm run test:all          # both
```

Integration tests spin up a dedicated Neo4j container on port `7688` with its own volume, run the full MCP tool suite against it, then tear it down and wipe the volume. Your dev database is never touched.

---

## Docs

| File | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System as built — graph model, layer rules, invariants |
| [`docs/mcp-tools.md`](docs/mcp-tools.md) | Full MCP tool contract: inputs, outputs, error codes, examples |
| [`docs/mcp-clients.md`](docs/mcp-clients.md) | Connecting to Claude, VS Code, ChatGPT, Ollama |
| [`docs/code-style.md`](docs/code-style.md) | Code patterns: safeTry controllers, remeda pipelines, zod decoding |
| [`docs/PLAN.md`](docs/PLAN.md) | Roadmap and future phases |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`CLAUDE.md`](CLAUDE.md) | Agent and contributor conventions |

---

## License

[MIT](LICENSE)
