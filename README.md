# FinTrack v2

AI-first personal finance manager. The primary interface is natural language through an **MCP server** — connect it to Claude or VS Code Copilot and talk to your finances directly. REST is a secondary surface.

**What's built:** transactions (expense/income/transfer), accounts, credit cards & bills, recurring rules, bulk import, auto-classification by merchant, sub-categories, and tags. Summaries group per currency; amounts are never converted implicitly.

**Local-first by design:** no database server, no containers, no cloud. Data lives in a single **encrypted libSQL (SQLite) file** on your machine; the encryption key is held in your OS keychain.

Stack: TypeScript · Fastify · zod · neverthrow · remeda · libSQL + Drizzle ORM.

---

## Try the demo

See FinTrack on sample data first — no install of your own data, no login, nothing touches your real finances:

```bash
npx @rafaelfcarneiro/fintrack@latest demo
```

It seeds four months of sample finances (pick a data set with `--country br|us|mx|co`) and serves the dashboards on
`http://127.0.0.1:51738`. To talk to it from your AI client, run `npx @rafaelfcarneiro/fintrack@latest setup <client> --demo`
and ask for the **`tour`** prompt on the `fintrack-demo` server. Details in [`docs/demo.md`](docs/demo.md).

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

FinTrack requires a login, even on your own machine. **The first time, `setup` asks you to choose the owner's username and password** (the password twice, never echoed; 12+ characters) before it writes the config. Afterwards it just says who the owner is and carries on. Log in to the dashboard (`/ui`) with them. Upgrading from an earlier version? Run `setup` (or `auth setup`) once: it claims your existing data's owner, and nothing is copied or lost. Forgot the password: `npx @rafaelfcarneiro/fintrack@latest auth reset-password`. Scripted installs: `printf %s "$PASSWORD" | npx @rafaelfcarneiro/fintrack@latest setup claude-code --username me --password-stdin`. Details: [`docs/auth.md`](docs/auth.md#first-setup).

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

After writing the config, `setup` offers to **sign that client in now** (a browser approval — see step 3). The setup command is safe to re-run — it skips the login step once the owner is claimed and merges idempotently, preserving any existing config keys. With no terminal and no `--password-stdin` it stops with instructions *before* writing any config.

> **Always use `@latest`.** `npx` with no version prefers an *installed* copy over the registry's, so a stale global install can run an old build. Every command here is pinned; check for a stale global copy with `npm ls -g @rafaelfcarneiro/fintrack`. An older build also refuses to run against a database a newer one has migrated, and says how to update.
If the target config file exists but is empty/invalid (or has a non-object JSON root), setup recovers automatically by replacing that root with a valid object.

### 3 — Restart your client and start chatting

Restart the AI client (or reload the window for VS Code). **The install flow ends with a sign-in:** a stdio session acts as nobody until you approve it. If you did not sign in during `setup`, Claude's first request shows a link and a code (`FinTrack: not signed in. Open …/ui/connect?code=ABCD-EFGH …`): open it, log in, check the code, choose read-only or read-and-write and how long it lasts (this session only, 24 hours, 7 days or 30 days), enter your password, and approve. From then on a restart of the client is silently signed in until it expires (24 hours, 7 days or 30 days — a "this session only" sign-in ends with the session, so the next start asks again); you can list and revoke sign-ins at `/ui/access/tokens`. From a terminal: `npx @rafaelfcarneiro/fintrack@latest login` / `logout`; for headless clients set `FINTRACK_TOKEN`. Details: [`docs/auth.md`](docs/auth.md#signing-in-claude-stdio). Then talk to your finances naturally. See [Sample usage](#sample-usage) below.

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

**HTTP mode quick-start** — start the server explicitly, then connect by URL. Authentication is on: claim the owner first (`setup`/`auth setup`), log in at `/ui`, and send a [personal access token](docs/auth.md#personal-access-tokens) (`Authorization: Bearer ftk_…`) from your client — or, for development only, `FINTRACK_AUTH=disabled` (loopback only) turns the login off:

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
(`/ui/access/tokens`), create a token (read-only or read+write, with an expiry), copy it — it is shown once — and send it as
`Authorization: Bearer ftk_…` to `http://127.0.0.1:51737/mcp` (MCP) or `/api` (REST). Per-client setup:
[`docs/mcp-clients.md`](docs/mcp-clients.md#docker-container-http-on-12700151737); how tokens, scopes and revocation work:
[`docs/auth.md`](docs/auth.md#personal-access-tokens).

Already running FinTrack through npm? Move its database and key into the container with `key export` and `db export`:
[`docs/auth.md`](docs/auth.md#moving-an-npm-install-to-docker).

Sharing the instance with someone else? Admins invite them at `/ui/access/users` (or `npx @rafaelfcarneiro/fintrack@latest users invite <name>`): they get a one-time
link, choose their own password, and see only their own finances. See [`docs/auth.md`](docs/auth.md#users-roles-and-invitations).

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
- **Bulk import a statement** — "Here's my bank statement for May: [paste]"
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
| [`docs/demo.md`](docs/demo.md) | The demo: what it contains, the `tour` prompt, reset and remove |
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
