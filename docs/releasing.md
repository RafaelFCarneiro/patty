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

## Container image (GHCR)

The same workflow publishes the container image (ADR-032) right after the npm release. The `release` job exposes
two outputs, `released` and `version`, read from the `vX.Y.Z` tag semantic-release creates on `HEAD` (it has no
`@semantic-release/git`, so `HEAD` is the tagged commit; no tag → `released=false`). The `image` job runs only when
`released == 'true'`:

- checks out the release tag, sets up QEMU + buildx, logs in to `ghcr.io` with `GITHUB_TOKEN`
  (`permissions: contents: read, packages: write`);
- tags `ghcr.io/rafaelfcarneiro/fintrack` as `X.Y.Z`, `X.Y`, `X` and `latest` — the same version as the npm package;
- builds **`linux/amd64` and `linux/arm64`** from the `Dockerfile` (the TypeScript build runs natively on the runner;
  only the production `npm ci` runs per target architecture), pushing with provenance and an SBOM and a GitHub Actions
  layer cache.

`ci.yml` builds the image for `linux/amd64` on every pull request (no push) and runs `scripts/docker-smoke.sh`
against it: read-only root, key from a mounted file, `/api/status` + `/ui` + MCP `initialize`, data surviving a
restart, no key in logs/config/volume, and a fast failure with the `openssl` hint when no key is supplied. Run it
locally with `docker build -t fintrack:ci . && scripts/docker-smoke.sh fintrack:ci`.

**One-time manual step:** a package first pushed to GHCR is **private** and linked to the repository only by label.
After the first image release, open the repository's **Packages → fintrack → Package settings** and set the
visibility you want (keep it private, or make it public so `docker compose up` works without `docker login ghcr.io`).
Private pulls need a token with `read:packages`.

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

By default this starts a **stdio MCP server** — the client spawns it directly (no port, no URL). See `docs/mcp-clients.md` for client config. To start in HTTP mode instead (REST + streamable HTTP MCP on port 51737): `MCP_TRANSPORT=http npx @rafaelfcarneiro/fintrack`. The package only replaces the clone + `npm run dev` step with a single command; the encrypted database at `<home directory>/.fintrack/fintrack.db` (key in the OS keychain; set `FINTRACK_DB_KEY` for headless) is otherwise identical.

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
(`bootstrap()` applies any pending Drizzle migrations idempotently), and your `<home directory>/.fintrack/fintrack.db` is untouched
otherwise. You'll see new releases on the repo's **Releases** page with auto-generated notes.

## Transport modes (`MCP_TRANSPORT`)

FinTrack supports two MCP transports, selected by the `MCP_TRANSPORT` env var (default `stdio`):

| Value | What starts | Port needed? | REST available? |
|-------|-------------|--------------|-----------------|
| `stdio` (default) | Client spawns the process; JSON-RPC over stdin/stdout, **plus** a best-effort Fastify sidecar on `PORT` (on by default) | Optional (non-fatal if taken) | Yes, unless the sidecar didn't bind |
| `stdio` + `FINTRACK_HTTP=false` | stdio MCP only, sidecar disabled | **No** | No |
| `http` | Fastify on `PORT` (default 51737); streamable HTTP MCP + REST | Yes (fatal if taken) | Yes |

The `stdio` transport itself has **no port concerns for the MCP connection** — the client always talks to it over stdin/stdout regardless of the sidecar. The sidecar (`/api` + `/ui`) starts automatically alongside it by default, since dashboards are a core feature, not an add-on (ADR-013 Decision 7) — see the next section for its bind behavior. Set `FINTRACK_HTTP=false` to run stdio-only with nothing bound at all.

## Port configuration (HTTP mode and the sidecar)

`HOST` (default `127.0.0.1`) is the bind address for the same HTTP server. Leave it on loopback for local use: the API has no authentication, so `HOST=0.0.0.0` (or `::`) exposes it to every device on the network. It exists for containers, where the host-side port publish must stay on loopback (`127.0.0.1:51737:51737`, ADR-032). Startup messages print `127.0.0.1` for a wildcard bind and the configured host otherwise.

`PORT` (default `51737` for the published package — deliberately not a common Node/Fastify dev-server port like 3000/3001/8080, to minimize collisions with other software; `npm run dev` overrides this to `3001` for contributors, see `docs/architecture.md` § HTTP sidecar) is read whenever the HTTP server starts: pure `http` mode, or the `stdio` sidecar (on by default). The server binds **one fixed port** — it does not auto-pick a free port, because the client config must match.

If you run several servers in HTTP mode, give each its own port:

```bash
MCP_TRANSPORT=http PORT=3007 npx @rafaelfcarneiro/fintrack
# then point the client at http://127.0.0.1:3007/mcp
```

**Bind-failure behavior differs by mode, by design (ADR-013 Decision 7):**

- **Pure `http` mode:** if the chosen port is already taken, startup fails fast with an actionable message (the port number and the exact `PORT=… fintrack` command to retry) rather than a raw `EADDRINUSE` stack trace, and the process exits — there's nothing else running to fall back to.
- **`stdio` sidecar (on by default):** the same conflict is **non-fatal** — this is a resilience fallback, not the normal state. The sidecar logs the same kind of actionable message to stderr and simply doesn't start; the stdio MCP connection keeps working, so the client can diagnose/free the port and you restart once it's free again.

How this lands in each HTTP-mode client:

- **VS Code** `.vscode/mcp.json`: set the `url` to your chosen port, e.g. `http://127.0.0.1:3007/mcp`.
- **Claude Desktop**: the `mcp-remote` bridge arg is the URL — point it at the same port.

## Cutting a first release

Versioning starts from `v1.0.0` on the first `feat:`-or-higher commit merged to `main` (semantic-release's
default for an untagged repo is `1.0.0`). To start lower, push an initial tag before the first release, e.g.
`git tag v0.1.0 && git push origin v0.1.0`, and the next `feat:` becomes `0.2.0`.
