# Setup from source

Running PATTY from a checkout. Installing the published package is in the [README](../README.md); everything about
signing in is in [`auth.md`](auth.md).

```bash
npm install
npm run dev   # stdio MCP server + HTTP sidecar (REST /api, /ui dashboards)
```

`npm run dev` pins `PORT=3001`; the published package defaults to `51737`, chosen to avoid common dev-server ports.
`npx ntl` lists every script with a description.

| Surface | From source | Published package |
|---|---|---|
| REST API | `http://127.0.0.1:3001/api` | `http://127.0.0.1:51737/api` |
| MCP (streamable HTTP) | `http://127.0.0.1:3001/mcp` | `http://127.0.0.1:51737/mcp` |
| Demo | — | `http://127.0.0.1:51738` |

The sidecar starts with stdio and is a core feature; `PATTY_HTTP=false` turns it off. `MCP_TRANSPORT=http` serves HTTP
only. A sidecar that cannot bind its port is non-fatal for stdio. `HOST` (default `127.0.0.1`) is the bind address.

## Database and key

The database is a local encrypted libSQL file (`patty.db`). The key comes from, in this order: `PATTY_DB_KEY_FILE`
(a file holding 64 hex characters — containers), `PATTY_DB_KEY` (CI), the OS keychain (generated on first run).
Setting both the file and the variable is a configuration error; with no source and no keychain, startup fails
(`openssl rand -hex 32`). Never commit or log the key. Moving a key or a database between installs:
[`auth.md`](auth.md#moving-an-npm-install-to-docker).

## Signing in during development

`PATTY_AUTH` defaults to `required` everywhere, so `npm run dev` needs a login too. Either claim the owner once:

```bash
npx tsx src/main.ts auth setup
```

or run `PATTY_AUTH=disabled npm run dev` (loopback only; a startup error on an exposed instance). Stdio clients sign in
with `PATTY_TOKEN` or a saved sign-in, otherwise every call answers "not signed in" with a link to approve. Terminal
equivalents (`login`, `logout`, `setup <client>`, `auth reset-password`, `users …`, `key …`, `db …`) and the exact
behaviour of each are in [`auth.md`](auth.md). Every printed or documented command is `npx @rfc0/patty@latest …`
(`NPX_COMMAND` in `src/models/package.ts`): an unpinned `npx` prefers a stale installed copy, and an older build refuses
a database a newer one migrated. A fresh instance prints a one-time setup code to stderr; the banner and `/ui/setup`
also show the terminal route (`TERMINAL_SETUP_HINT`, `src/models/auth/message.ts`).

## Docker

```bash
(umask 077; openssl rand -hex 32 > patty_db_key)
```

On Linux, then give the container's `node` user (uid 1000) the key; the file stays owner-only. Docker Desktop maps ownership itself, so skip this there:

```bash
sudo chown 1000 patty_db_key
```

Then start it:

```bash
docker compose up --build
```

Everything is served on
`http://127.0.0.1:51737` over loopback plain HTTP; the first start prints the setup code (`docker compose logs`) to
claim the owner at `/ui/setup`. MCP clients and scripts use `Authorization: Bearer ptk_…`, a token created at
`/ui/access/tokens` ([`mcp-clients.md`](mcp-clients.md)). Verify an image:
`docker build -t patty:ci . && scripts/docker-smoke.sh patty:ci`.

## Demo

`npx @rfc0/patty@latest demo [--country br|us|mx|co] [--reset]` serves a throwaway database of sample data with no
login; it never touches the real database. See [`demo.md`](demo.md).
