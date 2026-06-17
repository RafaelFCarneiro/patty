# Releasing & installing

FinTrack is published as a **private** npm package to **GitHub Packages**:
`@rafaelfcarneiro/fintrack`. Publishing is fully automated — no manual version bumps.

## How releases work (automated)

The `.github/workflows/release.yml` workflow runs on every push to `main`. It:

1. Installs deps, then runs the quality gate: `typecheck` → unit tests → integration tests → `build`.
2. Runs **semantic-release**, which inspects the Conventional Commits since the last release and:
   - `fix:` → patch (`0.1.0` → `0.1.1`)
   - `feat:` → minor (`0.1.0` → `0.2.0`)
   - `feat!:` / `BREAKING CHANGE:` → major (`0.1.0` → `1.0.0`)
   - `docs:` / `chore:` / `refactor:` / `test:` → **no release** (nothing publishes)
3. If there is a releasable change, it publishes the package, creates a GitHub Release with
   auto-generated notes, and tags the commit (`v0.2.0`).

There is **no version field to edit** — `package.json` stays at `0.0.0-development`; the real version
lives in git tags / the GitHub Release. semantic-release intentionally does **not** commit anything back
to `main` (no `@semantic-release/git` plugin), so it never fights branch protection.

Nothing extra is needed in the repo: the workflow authenticates with the built-in `GITHUB_TOKEN`
(scopes granted via the job's `permissions:` block). No secrets to configure.

## Installing & using the package (per machine, one-time auth)

Because the package is private on GitHub Packages, npm needs a token to download it.

1. Create a GitHub **Personal Access Token (classic)** with the `read:packages` scope:
   GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic).
2. Add it to your `~/.npmrc`:

   ```ini
   @rafaelfcarneiro:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=YOUR_READ_PACKAGES_TOKEN
   ```

3. Run it:

   ```bash
   npx @rafaelfcarneiro/fintrack          # one-off
   # or
   npm install -g @rafaelfcarneiro/fintrack && fintrack
   ```

By default this starts a **stdio MCP server** — the client spawns it directly (no port, no URL). See `docs/mcp-clients.md` for client config. To start in HTTP mode instead (REST + streamable HTTP MCP on port 3001): `MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack`. The package only replaces the clone + `npm run dev` step with a single command; the encrypted `fintrack.db` (key in the OS keychain; set `FINTRACK_DB_KEY` for headless) is otherwise identical.

## Updating to a new version

`npx` resolves to the latest published version, but it caches. To always run the newest:

```bash
npx @rafaelfcarneiro/fintrack@latest     # bypasses the npx cache, fetches newest
```

If you installed globally instead:

```bash
npm view @rafaelfcarneiro/fintrack version          # what's the latest published?
npm update -g @rafaelfcarneiro/fintrack             # update to it
npm ls -g @rafaelfcarneiro/fintrack   # confirm installed version
```

Upgrades are safe to run anytime: the database migrates itself forward on the next start
(`bootstrap()` applies any pending Drizzle migrations idempotently), and your `fintrack.db` is untouched
otherwise. You'll see new releases on the repo's **Releases** page with auto-generated notes.

## Transport modes (`MCP_TRANSPORT`)

FinTrack supports two MCP transports, selected by the `MCP_TRANSPORT` env var (default `stdio`):

| Value | What starts | Port needed? | REST available? |
|-------|-------------|--------------|-----------------|
| `stdio` (default) | Client spawns the process; JSON-RPC over stdin/stdout | **No** | No |
| `http` | Fastify on `PORT` (default 3001); streamable HTTP MCP + REST | Yes | Yes |

The default `stdio` mode has **no port concerns** — it can't conflict. Use it for all local MCP client configs (see `docs/mcp-clients.md`).

## Port configuration (HTTP mode only)

`PORT` is only read when `MCP_TRANSPORT=http`. The server binds **one fixed port** (default `3001`) — it does not auto-pick a free port, because the client config must match.

If you run several servers in HTTP mode, give each its own port:

```bash
MCP_TRANSPORT=http PORT=3007 npx @rafaelfcarneiro/fintrack
# then point the client at http://127.0.0.1:3007/mcp
```

If the chosen port is already taken, startup fails fast with an actionable message (the port number and the exact `PORT=… fintrack` command to retry) rather than a raw `EADDRINUSE` stack trace.

How this lands in each HTTP-mode client:

- **VS Code** `.vscode/mcp.json`: set the `url` to your chosen port, e.g. `http://127.0.0.1:3007/mcp`.
- **Claude Desktop**: the `mcp-remote` bridge arg is the URL — point it at the same port.

## Cutting a first release

Versioning starts from `v1.0.0` on the first `feat:`-or-higher commit merged to `main` (semantic-release's
default for an untagged repo is `1.0.0`). To start lower, push an initial tag before the first release, e.g.
`git tag v0.1.0 && git push origin v0.1.0`, and the next `feat:` becomes `0.2.0`.
