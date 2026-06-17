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

This starts REST + MCP on `http://localhost:3001` exactly like `npm run dev`, using a local encrypted
`fintrack.db` (key in the OS keychain; set `FINTRACK_DB_KEY` for headless). Connect Claude/VS Code to
`http://127.0.0.1:3001/mcp` as in `docs/mcp-clients.md` — the package only replaces the clone + `npm run dev`
step with a single command.

## Cutting a first release

Versioning starts from `v1.0.0` on the first `feat:`-or-higher commit merged to `main` (semantic-release's
default for an untagged repo is `1.0.0`). To start lower, push an initial tag before the first release, e.g.
`git tag v0.1.0 && git push origin v0.1.0`, and the next `feat:` becomes `0.2.0`.
