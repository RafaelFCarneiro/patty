# FinTrack v2

AI-first personal finance manager. The primary interface is natural language through an **MCP server** — connect it to Claude or VS Code Copilot and talk to your finances directly. REST is a secondary surface.

**What's built:** transactions (expense/income/transfer), accounts, credit cards & bills, recurring rules, bulk import, auto-classification by merchant, sub-categories, and tags. Summaries group per currency; amounts are never converted implicitly.

**Local-first by design:** no database server, no containers, no cloud. Data lives in a single **encrypted libSQL (SQLite) file** on your machine; the encryption key is held in your OS keychain.

Stack: TypeScript · Fastify · zod · neverthrow · remeda · libSQL + Drizzle ORM.

---

## Getting started

### 1 — Authenticate (one-time per machine)

FinTrack publishes privately to **GitHub Packages**. Create a GitHub token with the `read:packages` scope and add it to `~/.npmrc` (full steps in [`docs/releasing.md`](docs/releasing.md)):

```ini
@rafaelfcarneiro:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_READ_PACKAGES_TOKEN
```

### 2 — Connect your AI client

Run the setup command for your agent — it downloads FinTrack, writes the correct config, and exits. No server to start separately; the client manages that automatically from this point on.

```bash
npx @rafaelfcarneiro/fintrack@latest setup claude-code      # Claude Code CLI
npx @rafaelfcarneiro/fintrack@latest setup claude-desktop   # Claude Desktop
npx @rafaelfcarneiro/fintrack@latest setup copilot          # VS Code / GitHub Copilot
npx @rafaelfcarneiro/fintrack@latest setup antigravity      # Google Antigravity
npx @rafaelfcarneiro/fintrack@latest setup codex            # OpenAI Codex (prints snippet)
```

Run without a tool name to list all options and the config file each one writes:

```bash
npx @rafaelfcarneiro/fintrack@latest setup
```

The setup command is safe to re-run — it merges idempotently, preserving any existing config keys.

### 3 — Restart your client and start chatting

Restart the AI client (or reload the window for VS Code), then talk to your finances naturally. See [Sample usage](#sample-usage) below.

> **Updating:** re-run the same setup command. `npx` with `@latest` always fetches the newest published version.

---

## Transports

| Mode | When | How |
|---|---|---|
| **stdio** (default) | A client launches FinTrack directly — no port, no conflicts. | Client config points at `npx @rafaelfcarneiro/fintrack@latest` |
| **http** (`MCP_TRANSPORT=http`) | REST API, multi-client, or debugging via the Inspector. | `http://localhost:3001` (`/mcp`, `/api`) |

---

## Manual config and HTTP mode

Prefer the `setup` command above. If you need to configure manually or use HTTP mode, see [`docs/mcp-clients.md`](docs/mcp-clients.md) for per-client JSON snippets, ChatGPT, Ollama, port details, and debugging.

**HTTP mode quick-start** — start the server explicitly, then connect by URL:

```bash
MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack@latest   # published package
MCP_TRANSPORT=http npm run dev                             # from source
```

VS Code `.vscode/mcp.json` (HTTP):

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }
```

> Use `127.0.0.1`, not `localhost` — VS Code resolves `localhost` to IPv6 `::1`.

---

## Development (from source)

```bash
npm install
npm run dev          # stdio MCP server (reads stdin)
```

```bash
MCP_TRANSPORT=http npm run dev   # REST + MCP on http://localhost:3001
npm run mcp:inspect              # MCP Inspector → http://127.0.0.1:3001/mcp
```

Run `npx ntl` for an interactive, described list of all scripts. On first run (any mode) FinTrack creates `~/.fintrack/fintrack.db` and generates the encryption key in your OS keychain.

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

Integration tests run against an ephemeral in-process libSQL database, exercise the full MCP tool suite, and never touch your real `<home directory>/.fintrack/fintrack.db`.

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

[Apache-2.0](LICENSE)
