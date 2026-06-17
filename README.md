# FinTrack v2

AI-first personal finance manager. The primary interface is natural language through an **MCP server** — connect it to Claude or VS Code Copilot and talk to your finances directly. REST is a secondary surface.

**What's built:** transactions (expense/income/transfer), accounts, credit cards & bills, recurring rules, bulk import, auto-classification by merchant, sub-categories, and tags. Summaries group per currency; amounts are never converted implicitly.

**Local-first by design:** no database server, no containers, no cloud. Data lives in a single **encrypted libSQL (SQLite) file** on your machine; the encryption key is held in your OS keychain.

Stack: TypeScript · Fastify · zod · neverthrow · remeda · libSQL + Drizzle ORM.

---

## Install & run

### As a package (recommended)

FinTrack publishes privately to **GitHub Packages**. One-time per machine: create a GitHub token with the `read:packages` scope and add it to `~/.npmrc` (full steps in [`docs/releasing.md`](docs/releasing.md)):

```ini
@rafaelfcarneiro:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_READ_PACKAGES_TOKEN
```

Then run it — by default it starts as a **stdio MCP server** (no port, no setup):

```bash
npx @rafaelfcarneiro/fintrack@latest
```

On first run it creates the local `fintrack.db` and generates the encryption key in your keychain.

### From source (development)

```bash
npm install
npm run dev          # stdio MCP server (reads stdin)
```

For manual testing or the MCP Inspector, run in HTTP mode instead:

```bash
MCP_TRANSPORT=http npm run dev          # REST + MCP on http://localhost:3001
npm run mcp:inspect                     # MCP Inspector → http://127.0.0.1:3001/mcp
```

Run `npx ntl` for an interactive, described list of all scripts.

---

## Transports

| Mode | When | Endpoint |
|---|---|---|
| **stdio** (default) | A client launches the process directly. No port, no conflicts. | stdin/stdout |
| **http** (`MCP_TRANSPORT=http`) | REST API, multi-client, or debugging via the Inspector. | `http://localhost:3001` (`/mcp`, `/api`) |

---

## Connecting to AI clients

### stdio (recommended — the client launches FinTrack)

No server to start beforehand, no port. Point the client at the command.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
"mcpServers": {
  "fintrack": { "command": "npx", "args": ["-y", "@rafaelfcarneiro/fintrack"] }
}
```

**VS Code / GitHub Copilot** — `.vscode/mcp.json` (tools appear in **Agent** mode only):

```json
{ "servers": { "fintrack": { "command": "npx", "args": ["-y", "@rafaelfcarneiro/fintrack"] } } }
```

**Claude Code (CLI):**

```bash
claude mcp add fintrack -- npx -y @rafaelfcarneiro/fintrack
```

### HTTP (opt-in)

Start the server in HTTP mode (`MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack`, or `MCP_TRANSPORT=http npm run dev` from source), then connect by URL — e.g. VS Code `.vscode/mcp.json`:

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

> Use `127.0.0.1`, not `localhost` — VS Code resolves `localhost` to IPv6 `::1`.

Running several MCP servers? Only HTTP mode uses a port; give each one its own via `PORT` (stdio never collides). Full guide (ChatGPT, Ollama, port details, debugging): [`docs/mcp-clients.md`](docs/mcp-clients.md).

---

## Sample usage

Once connected, talk to Claude naturally:

- **Log a transaction** — "Paguei 32,50 de Uber ontem"
- **Bulk import a statement** — "Here's my Nubank statement for May: [paste]"
- **Monthly summary** — "What did I spend in June? Break it down by category."
- **Tag and search** — "Tag last week's restaurant transactions as 'work-dinner', then show me everything tagged work-dinner this month."
- **Credit card bill** — "What's on my Itaú card bill for June? Mark it as paid."
- **Recurring rule** — "I pay R$59 for Spotify every month on the 10th. Set that up as a recurring expense."

---

## Testing

```bash
npm test                  # unit tests (vitest)
npm run test:integration  # MCP integration tests — in-process libSQL DB, no Docker required
npm run test:all          # both
```

Integration tests run against an ephemeral in-process libSQL database, exercise the full MCP tool suite, and never touch your real `fintrack.db`.

---

## Docs

| File | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System as built — relational schema, layer rules, invariants |
| [`docs/mcp-tools.md`](docs/mcp-tools.md) | Full MCP tool contract: inputs, outputs, error codes, examples |
| [`docs/mcp-clients.md`](docs/mcp-clients.md) | Connecting to Claude, VS Code, ChatGPT, Ollama |
| [`docs/releasing.md`](docs/releasing.md) | Publishing, installing the private package, updating, ports |
| [`docs/code-style.md`](docs/code-style.md) | Code patterns: safeTry controllers, remeda pipelines, zod decoding |
| [`docs/PLAN.md`](docs/PLAN.md) | Roadmap and future phases |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`CLAUDE.md`](CLAUDE.md) | Agent and contributor conventions |

---

## License

[MIT](LICENSE)
