# Releasing & installing

PATTY is published as a **public** npm package, `@rfc0/patty`, on npmjs.com, and as the public container image
`ghcr.io/rafaelfcarneiro/patty` (ADR-035 §3). Versions are automatic — no manual bumps — but **nothing goes live
without the owner's approval**, twice: once for npm, once for the image's `latest` tag.

## How releases work

The `.github/workflows/release.yml` workflow runs on every push to `main`. It:

1. Installs deps, then runs the quality gate: `typecheck` → unit tests → integration tests → `build`.
2. Runs **semantic-release**, which inspects the Conventional Commits since the last release and:
   - `fix:` → patch (`0.1.0` → `0.1.1`)
   - `feat:` → minor (`0.1.0` → `0.2.0`)
   - `feat!:` / `BREAKING CHANGE:` → major (`0.1.0` → `1.0.0`)
   - `docs:` / `chore:` / `refactor:` / `test:` → **no release** (nothing publishes)
3. If there is a releasable change, semantic-release creates the `patty-vX.Y.Z` tag and the GitHub Release with
   auto-generated notes, and writes the version into `package.json` for this run. Its npm plugin has
   `npmPublish: false`: it versions, it does not publish.
4. The next step of the same job **stages** the version: `npm install -g npm@latest`, then
   `npm stage publish --access public` against `https://registry.npmjs.org`, through npm **trusted publishing**
   (OIDC: the job has `id-token: write`, and there is no npm token or secret anywhere). Provenance is automatic.
   A staged version is not installable and does not move `latest`.

There is **no version field to edit** — `package.json` stays at `0.0.0-development`; the real version lives in git
tags / the GitHub Release. semantic-release intentionally does **not** commit anything back to `main` (no
`@semantic-release/git` plugin), so it never fights branch protection.

### Approving a release (two approvals, in this order)

1. **npm.** Open the staged version on npmjs.com (package `@rfc0/patty` → staged versions) and approve it — or run
   `npm stage approve <id>` (needs 2FA). Until then `npx @rfc0/patty@latest` keeps resolving to the previous approved
   version.
2. **Docker `latest`.** The `image` job has already pushed `ghcr.io/rafaelfcarneiro/patty:X.Y.Z` (and `X.Y`, `X`).
   The `promote-latest` job waits on the **`release`** GitHub Environment, which requires the owner's approval:
   Actions → the run → *Review deployments* → approve. It then moves `:latest` to that version. Approve it **after**
   the npm version, so `npx …@latest` and `docker pull …:latest` move together.

### `RELEASE_ENABLED` (the switch)

The whole workflow is gated with `if: vars.RELEASE_ENABLED == 'true'`. The repository variable **is unset** until the
rename is done and the pre-publication scan has passed (ADR-035 steps 6–7), so a merge to `main` runs nothing here
and publishes nothing. To turn releases on: Settings → Secrets and variables → Actions → Variables →
`RELEASE_ENABLED` = `true`. To stop them again, delete the variable or set it to anything else.

### One-time setup (before the first automated release)

- **The first version is published by hand.** npm offers the trusted-publisher setting only on an existing package, so
  the very first version is published from a terminal with 2FA (`npm publish --access public`), as
  `@rfc0/effect-runner`'s `0.2.0` was.
- **Trusted publisher.** On npmjs.com → `@rfc0/patty` → Settings → Trusted publisher: GitHub Actions, repository
  `RafaelFCarneiro/patty`, workflow `release.yml`, environment left empty.
- **GitHub Environment.** Create the environment **`release`** (Settings → Environments) with *Required reviewers*
  set to the owner.
- **Delete the old private package** on GitHub Packages once the move is done.

## Secret scanning

The `Secret scan` workflow (`.github/workflows/secrets.yml`, no path filter, so Markdown-only changes are scanned
too) runs the gitleaks image, pinned by version, over the exact commit range (base..head, however many
commits) that every pull request and push to `main` adds. The history already on `main` was scanned once, over every
ref, before publication (ADR-035 §4).

- New kinds of false positive get a narrow allowlist entry in `.gitleaks.toml` with a `description` — never a blanket
  path outside `legacy/`, never an inline suppression (CI ignores `gitleaks:allow` comments). Entries name their rule and match the finding's secret
  together with the path (not the whole line), by pattern rather than commit SHA, so they survive squash merges.
- `.gitleaksignore` holds the fingerprints of the pre-publication history, for full-history local scans.
- `Secret scan` is a required status check on `main` (set in the branch protection rule).

## Container image (GHCR)

The same workflow publishes the container image (ADR-032) right after the release is cut. The `release` job exposes
two outputs, `released` and `version`, read from the `patty-vX.Y.Z` tag semantic-release creates on `HEAD` (it has no
`@semantic-release/git`, so `HEAD` is the tagged commit; no tag → `released=false`). The `image` job runs only when
`released == 'true'`:

- checks out the release tag, sets up QEMU + buildx, logs in to `ghcr.io` with `GITHUB_TOKEN`
  (`permissions: contents: read, packages: write`);
- tags `ghcr.io/rafaelfcarneiro/patty` as `X.Y.Z`, `X.Y` and `X` — never `latest`: that moves only in the `promote-latest` job, behind the `release` environment's approval;
- builds **`linux/amd64` and `linux/arm64`** from the `Dockerfile` (the TypeScript build runs natively on the runner;
  only the production `npm ci` runs per target architecture), pushing with provenance and an SBOM and a GitHub Actions
  layer cache.

`ci.yml` builds the image for `linux/amd64` on pull requests (no push) **when something the image is built from changed**
(`scripts/container-files-changed.sh`: `Dockerfile`, `src/`, `ui/`, `drizzle/`, `skills/`, package and tsconfig files,
`compose.yaml`, the smoke script and the CI plumbing — otherwise the job's steps are skipped and the check still passes)
and runs `scripts/docker-smoke.sh` against it: read-only root, key from a mounted file, the unauthenticated surface limited to `/api/health` (ADR-033),
the setup code read from the container log and exchanged at `/ui/setup`, then `/api/status` + `/ui` + MCP `initialize`
with the session cookie and a matching `Origin`, a cross-origin write refused, the owner/session/data surviving a
restart with no second setup code, personal access tokens minted through the session and used as a bearer on `/mcp` and `/api` (a read token refused `403 insufficient_scope` on a write tool and route, a bad bearer never falling back to the cookie, no credential answered `401` with a `resource_metadata` URL that resolves, a revoked token refused at once), no key/password/session or access token in logs/config/volume, and a fast failure with the `openssl` hint when no key is supplied. Run it
locally with `docker build -t patty:ci . && scripts/docker-smoke.sh patty:ci`.
`scripts/docker-move-smoke.sh patty:ci` (from the repository root, with dependencies installed) runs the npm→Docker move guide of `docs/auth.md` end to end; it is a local check and is not part of CI.

### Base-image mirror (why builds don't pull from Docker Hub)

Docker Hub answers `429 Too Many Requests` to anonymous pulls from GitHub's shared runner IPs, which intermittently failed
the image build before it ran anything of ours. So CI and release build `FROM` a copy of the base image kept in our own
registry:

- `.github/workflows/mirror-base-image.yml` copies `docker.io/library/<tag>` (the Dockerfile's `ARG NODE_IMAGE` default —
  the single source of which image) to `ghcr.io/rafaelfcarneiro/node-mirror:<tag>` with `docker buildx imagetools create`
  (registry to registry, multi-arch index, no layers pulled). It runs weekly (to pick up the base image's security
  rebuilds), on a push to `main` that changes the Dockerfile or the workflow, and on demand (Actions → *Mirror base image*
  → *Run workflow*); it retries with back-off because it can hit the same 429.
- `.github/actions/base-image` (used by the PR Docker job and the release `image` job) logs in to GHCR and passes the
  mirror to the build as `NODE_IMAGE` when it is readable, **falling back to Docker Hub** when it is not — so a missing,
  late or unreadable mirror makes a build no worse than before, never blocks it. The build log says which one was used
  (`::notice::Building FROM …`).
- The mirror is the same image (same digests), so the published image's provenance is unchanged.

**One-time manual steps:** after the mirror workflow's first run (it triggers when this workflow first lands on `main`),
check **Packages → node-mirror → Package settings**: the package should be linked to this repository (the workflow sets
the `org.opencontainers.image.source` annotation) so `GITHUB_TOKEN` in CI can read it; if not, add the repository under
*Manage Actions access* with read access. Until then builds fall back to Docker Hub.

**One-time manual step:** a package first pushed to GHCR is **private** and linked to the repository only by label.
After the first image release, open the repository's **Packages → patty → Package settings** and set the visibility to
**public**, so `docker compose up` and `docker pull` work without `docker login ghcr.io`.

In the same place, open **Manage Actions access** and confirm this repository is listed with the **Write** role, adding it
if not. The first image is pushed by hand, so the package is not yet tied to the workflow: until the repository has
write access, the workflow's `GITHUB_TOKEN` cannot push the next image. Grant it before the first automated image push.

## Installing & using the package

The package is public on npmjs.com: no token, no `~/.npmrc` entry.

```bash
npx @rfc0/patty@latest          # one-off
# or (a global install is NOT refreshed by `npx` — see "Why an older build refuses a newer database" below)
npm install -g @rfc0/patty && patty
```

By default this starts a **stdio MCP server** — the client spawns it directly (no port, no URL). See `docs/mcp-clients.md` for client config. To start in HTTP mode instead (REST + streamable HTTP MCP on port 51737): `MCP_TRANSPORT=http npx @rfc0/patty@latest`. The package only replaces the clone + `npm run dev` step with a single command; the encrypted database at `<home directory>/.patty/patty.db` (key in the OS keychain; set `PATTY_DB_KEY` for headless) is otherwise identical.

## Updating to a new version

`npx` resolves to the latest published version, but it caches. To always run the newest:

```bash
npx @rfc0/patty@latest     # bypasses the npx cache, fetches newest
```

If you installed globally instead:

```bash
npm view @rfc0/patty version          # what's the latest published?
npm update -g @rfc0/patty             # update to it
npm ls -g @rfc0/patty   # confirm installed version
```

Upgrades are safe to run anytime: the database migrates itself forward on the next start
(`bootstrap()` applies any pending Drizzle migrations idempotently), and your `<home directory>/.patty/patty.db` is untouched
otherwise. You'll see new releases on the repo's **Releases** page with auto-generated notes.

## Why an older build refuses a newer database (the version guard)

`bootstrap()` — and so the server and every command that opens the database — first compares the database's newest applied migration
(`__drizzle_migrations.created_at`, i.e. the journal entry's `when`) with the newest entry in the migrations journal **this build ships**. If the
database is ahead, the process exits non-zero with `databaseAheadMessage` (`models/database.ts`) before it takes the safety copy, migrates, seeds or writes anything
(`diplomat/db/version-guard.ts`, rule in `logic/migration.ts`).

It exists because of a field incident: running `auth setup` through an **unpinned** `npx` (no `@latest`) resolved to a **stale global install**. That build did not know `auth setup`, started as a
server, and failed inside an old seed against the newer schema. No data was harmed, but neither half should be possible: every printed command is now `@latest`-pinned
(`NPX_COMMAND`), and an older build now refuses instead of seeding into a schema it does not know.

Consequences for releases:

- **The guard only protects builds that include it.** A build released before it has no guard, so a stale copy of *that* generation can still run against a newer database
  — hence the `@latest` pinning, and the global-install check `npm ls -g @rfc0/patty` in the message.
- **Journal `when` values must only grow.** Drizzle stamps each applied migration with its journal entry's `when`; the guard reads that as "newer". Generate migrations in order
  (`drizzle-kit generate`), never hand-edit an earlier entry's `when` upwards past a later one, and never rebase a migration to an earlier timestamp than one already released.
- **`drizzle-kit generate` cannot load the schema as-is**: `schema.ts` imports models that import `@rfc0/effect-runner`, whose `exports` map has an `import` condition only, and drizzle-kit loads the schema through `require`. Temporarily add `"default": "./dist/index.js"` next to `"import"` in `node_modules/@rfc0/effect-runner/package.json`, run `npx drizzle-kit generate --name <name>`, then restore the file (`npm ci` also does). A migration that drops a UNIQUE constraint or adds a NOT NULL foreign key needs a hand-written table rebuild (see `drizzle/0021_tenancy_data.sql`): keep the generated snapshot, replace the generated SQL.
- A migration that was released and then dropped from the journal leaves databases "ahead" of every later build — treat a released migration as permanent (add a new one to undo it).

## Dependency upgrades — `drizzle-orm`, `drizzle-kit`, `@libsql/client`

`src/diplomat/db/migration-barrier.ts` **mirrors drizzle's libSQL migrator** (`drizzle-orm/libsql`'s `migrate()` and
`@libsql/client`'s `migrate()`/`transaction()` underneath): it applies a pending data-rewriting migration inside one
write transaction so the pre-migration backup cannot miss a concurrent writer (ADR-033 § 7). Bumping any of those
three packages therefore **requires the parity tests to pass** — `npx vitest run --config vitest.integration.config.ts
test/integration/db/owner-migration.test.ts` — before merging. They migrate the same pre-auth database through this
runner and through drizzle alone and compare the schema, every `__drizzle_migrations` row, the data, and the app
connection's `foreign_keys`/`busy_timeout`. A failure means drizzle's behavior changed: update the runner to match
(or remove it) — never relax the test.

## Transport modes (`MCP_TRANSPORT`)

PATTY supports two MCP transports, selected by the `MCP_TRANSPORT` env var (default `stdio`):

| Value | What starts | Port needed? | REST available? |
|-------|-------------|--------------|-----------------|
| `stdio` (default) | Client spawns the process; JSON-RPC over stdin/stdout, **plus** a best-effort Fastify sidecar on `PORT` (on by default) | Optional (non-fatal if taken) | Yes, unless the sidecar didn't bind |
| `stdio` + `PATTY_HTTP=false` | stdio MCP only, sidecar disabled | **No** | No |
| `http` | Fastify on `PORT` (default 51737); streamable HTTP MCP + REST | Yes (fatal if taken) | Yes |

The `stdio` transport itself has **no port concerns for the MCP connection** — the client always talks to it over stdin/stdout regardless of the sidecar. The sidecar (`/api` + `/ui`) starts automatically alongside it by default, since dashboards are a core feature, not an add-on (ADR-013 Decision 7) — see the next section for its bind behavior. Set `PATTY_HTTP=false` to run stdio-only with nothing bound at all.

## Port configuration (HTTP mode and the sidecar)

`HOST` (default `127.0.0.1`) is the bind address for the same HTTP server. Leave it on loopback for local use: the API has no authentication, so `HOST=0.0.0.0` (or `::`) exposes it to every device on the network. It exists for containers, where the host-side port publish must stay on loopback (`127.0.0.1:51737:51737`, ADR-032). Startup messages print `127.0.0.1` for a wildcard bind and the configured host otherwise.

`PORT` (default `51737` for the published package — deliberately not a common Node/Fastify dev-server port like 3000/3001/8080, to minimize collisions with other software; `npm run dev` overrides this to `3001` for contributors, see `docs/architecture.md` § HTTP sidecar) is read whenever the HTTP server starts: pure `http` mode, or the `stdio` sidecar (on by default). The server binds **one fixed port** — it does not auto-pick a free port, because the client config must match.

If you run several servers in HTTP mode, give each its own port:

```bash
MCP_TRANSPORT=http PORT=3007 npx @rfc0/patty@latest
# then point the client at http://127.0.0.1:3007/mcp
```

**Bind-failure behavior differs by mode, by design (ADR-013 Decision 7):**

- **Pure `http` mode:** if the chosen port is already taken, startup fails fast with an actionable message (the port number and the exact `PORT=… patty` command to retry) rather than a raw `EADDRINUSE` stack trace, and the process exits — there's nothing else running to fall back to.
- **`stdio` sidecar (on by default):** the same conflict is **non-fatal** — this is a resilience fallback, not the normal state. The sidecar logs the same kind of actionable message to stderr and simply doesn't start; the stdio MCP connection keeps working, so the client can diagnose/free the port and you restart once it's free again.

How this lands in each HTTP-mode client:

- **VS Code** `.vscode/mcp.json`: set the `url` to your chosen port, e.g. `http://127.0.0.1:3007/mcp`.
- **Claude Desktop**: the `mcp-remote` bridge arg is the URL — point it at the same port.

## Tag format and version line

Release tags are `patty-vX.Y.Z` (`tagFormat` in `.releaserc.json`; `release.yml` defines the prefix once as
`TAG_PREFIX`). `@rfc0/patty` is a new package, so it starts its own version line at `1.0.0` instead of continuing
FinTrack's `v4.x`. semantic-release finds the previous release from git tags, and no existing tag matches the new
format. The `v4.x` tags and GitHub Releases are FinTrack history: they stay in the repository and are never deleted
(`cleanup-releases.yml` prunes only `patty-v*` releases).
npm versions and Docker tags are bare semver (`1.0.0`, `:1.0.0`); only the git tag carries the prefix.

## Cutting the first release (ADR-035 step 7)

With no `patty-v*` tag, the workflow's first run would put the whole history into the release notes, so the first
version is tagged by hand, in this order:

1. On a clean checkout of the commit to release, run `npm ci && npm run lint && npm run typecheck && npm run test:all
   && npm run build` (`dist/` is gitignored and the executable is `dist/main.js`, so publishing without the build
   ships nothing runnable). Then publish `@rfc0/patty@1.0.0` by hand from that checkout with 2FA: `package.json`
   carries `0.0.0-development`, so set the version for this publish only (`npm version 1.0.0 --no-git-tag-version`,
   not committed) and run `npm publish --access public`.
2. Push the tag `patty-v1.0.0` on that same commit: `git tag patty-v1.0.0 <commit> && git push origin patty-v1.0.0`.
3. Create its GitHub Release from that tag with short hand-written notes.
4. Publish the first image by hand, since pushing a tag or creating a Release does not start `release.yml` and a
   rerun on a tagged commit skips the image: from the same checkout, log in to `ghcr.io` (a token with
   `write:packages`) and run `docker buildx build --platform linux/amd64,linux/arm64 --build-arg VERSION=1.0.0
   --provenance=mode=max --sbom=true -t ghcr.io/rafaelfcarneiro/patty:1.0.0 -t ghcr.io/rafaelfcarneiro/patty:1.0
   -t ghcr.io/rafaelfcarneiro/patty:1 -t ghcr.io/rafaelfcarneiro/patty:latest --push .`. Tagging `latest` here is the
   owner's approval for the first version; later versions go through the `release` environment.
5. Configure the trusted publisher on npmjs.com and the `release` environment on GitHub (see *One-time setup*).
6. Set the repository variable `RELEASE_ENABLED` to `true`. The workflow continues from `patty-v1.0.0`
   (`1.0.1`, `1.1.0`, …).
