# FinTrack v2

AI-first personal finance manager. The primary interface is natural language through an **MCP server** — connect it to Claude or VS Code Copilot and talk to your finances directly. REST is a secondary surface.

**What's built:** transactions (expense/income/transfer), accounts, credit cards & bills, recurring rules, bulk import, auto-classification by merchant, sub-categories, and tags. Summaries group per currency; amounts are never converted implicitly.

**Local-first by design:** no database server, no containers, no cloud. Data lives in a single **encrypted libSQL (SQLite) file** on your machine; the encryption key is held in your OS keychain.

Stack: TypeScript · Fastify · zod · neverthrow · remeda · libSQL + Drizzle ORM.

---

## Getting started

### 0 — Prerequisites

Before running `npx`, make sure these tools are installed:

- **Node.js 25.x**
- **npm 11+**

Quick check:

```bash
node -v
npm -v
```

If needed, install from [nodejs.org](https://nodejs.org/) (recommended) or via your package manager (`nvm`, `fnm`, `asdf`, Homebrew).

### 1 — Authenticate (one-time per machine)

FinTrack publishes privately to **GitHub Packages**. Create a GitHub token with the `read:packages` scope and add it to `~/.npmrc`.

1. Create a GitHub **Personal Access Token (classic)** with the `read:packages` scope:
   GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic).
2. Add it to your `~/.npmrc`:

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
If the target config file exists but is empty/invalid (or has a non-object JSON root), setup recovers automatically by replacing that root with a valid object.

### 3 — Restart your client and start chatting

Restart the AI client (or reload the window for VS Code), then talk to your finances naturally. See [Sample usage](#sample-usage) below.

> **Updating:** re-run the same setup command. `npx` with `@latest` always fetches the newest published version.

---

## Transports

| Mode | When | How |
|---|---|---|
| **stdio** (default) | A client launches FinTrack directly — no port, no conflicts. | Client config points at `npx @rafaelfcarneiro/fintrack@latest` |
| **http** (`MCP_TRANSPORT=http`) | REST API, multi-client, or debugging via the Inspector. | `http://127.0.0.1:51737` (`/mcp`, `/api`) — `:3001` if run via `npm run dev` |

---

## Manual config and HTTP mode

Prefer the `setup` command above. If you need to configure manually or use HTTP mode, see [`docs/mcp-clients.md`](docs/mcp-clients.md) for per-client JSON snippets, ChatGPT, Ollama, port details, and debugging.

**HTTP mode quick-start** — start the server explicitly, then connect by URL:

```bash
MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack@latest   # published package → :51737
MCP_TRANSPORT=http npm run dev                             # from source → :3001
```

VS Code `.vscode/mcp.json` (HTTP, published package):

```json
{ "servers": { "fintrack": { "type": "http", "url": "http://127.0.0.1:51737/mcp" } } }
```

> Use `127.0.0.1`, not `localhost` — VS Code resolves `localhost` to IPv6 `::1`. Running from source
> instead? Use port `3001` (this repo's `.vscode/mcp.json` already does).

---

## Docker

Run FinTrack as a container instead of through npm: the dashboards (`/ui`), REST (`/api`) and the MCP endpoint (`/mcp`)
are served from one port, and your data lives in a Docker volume.

```bash
(umask 077; openssl rand -hex 32 > fintrack_db_key)   # the database encryption key, owner-only
sudo chown 1000 fintrack_db_key   # Linux only: the container's unprivileged user (uid 1000) must own it; skip on Docker Desktop
docker compose up -d --build      # builds from source; or, with GHCR access, drop --build to pull the image
```

The published image `ghcr.io/rafaelfcarneiro/fintrack` is private. Pulling it requires
`docker login ghcr.io` with a GitHub token that has `read:packages`; otherwise build from source as above.

The first start prints a one-time **setup code** to the container log. Claim the instance with it:

```bash
docker compose logs fintrack      # find the code: XXXX-XXXX-XXXX-XXXX-XXXX
```

Open <http://127.0.0.1:51737/ui/setup>, enter the code, and choose a username and a password (12+ characters).
You're logged in; the code is single-use and a restart before you finish prints a fresh one.
The container requires a login for everything except `/api/health` — see [`docs/auth.md`](docs/auth.md).

Connect an MCP client or script with a **personal access token**: in the dashboard open the key icon in the sidebar
(`/ui/account/tokens`), create a token (read-only or read+write, with an expiry), copy it — it is shown once — and send it as
`Authorization: Bearer ftk_…` to `http://127.0.0.1:51737/mcp` (MCP) or `/api` (REST). Per-client setup:
[`docs/mcp-clients.md`](docs/mcp-clients.md#docker-container-http-on-12700151737); how tokens, scopes and revocation work:
[`docs/auth.md`](docs/auth.md#personal-access-tokens).

- **Loopback only.** `compose.yaml` publishes `127.0.0.1:51737:51737`. The login protects the API, but the
  container speaks plain HTTP — publishing as `51737:51737` would send your password and session across the network
  in the clear. Keep the publish on loopback until TLS-terminating proxy support is documented.
- **One replica per volume.** SQLite and the in-process scheduler assume a single process; don't scale the service.
- **Backup = the volume *and* the key.** The database is encrypted; if you lose `fintrack_db_key` the data is
  unrecoverable. Back both up (and keep the key somewhere other than next to the volume backup).
- The image is multi-arch (`linux/amd64`, `linux/arm64`) and hardened in compose: non-root, read-only root filesystem
  (only `/data` and a `/tmp` tmpfs are writable), all capabilities dropped. The private package/image visibility is
  covered in [`docs/releasing.md`](docs/releasing.md#container-image-ghcr).

---

## Development (from source)

```bash
npm install
npm run dev          # stdio MCP server (reads stdin)
```

```bash
MCP_TRANSPORT=http npm run dev   # REST + MCP on http://127.0.0.1:3001
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
