# ADR-035: Rename to PATTY and go public

**Status:** Accepted · **Date:** 2026-11-03 · **Deciders:** Rafael · **Revises ADR-032** (where the image and
package are published) and every place an earlier ADR names the product.

## Context

The name FinTrack is already used by other products. The project is about to become public — the repository, the
npm package and the Docker image — so the name changes first, while its only real user is its author.

The new name is **PATTY — Personal Agent Tracking for Treasure and Yield**.

The name is not only text. About a dozen identifiers are things an existing install depends on (the data directory,
the keychain entry, environment variables, the MCP server name, stored token scopes). Renaming them blindly makes an
existing database unreachable. At the same time, the product must not keep the old name around in compatibility code.

## Decision

### 1. The new names (clean break, no aliases)

| Concern | Today | After |
|---|---|---|
| GitHub repository | `RafaelFCarneiro/fintrack` | `RafaelFCarneiro/patty` |
| npm package | `@rafaelfcarneiro/fintrack` (GitHub Packages, private) | `@rfc0/patty` (npmjs.com, public) |
| CLI binary | `fintrack` | `patty` |
| Docker image | `ghcr.io/rafaelfcarneiro/fintrack` | `ghcr.io/rafaelfcarneiro/patty` |
| Data directory / file | `~/.fintrack/fintrack.db`, `demo.db` | `~/.patty/patty.db`, `demo.db` |
| Keychain service | `fintrack` (accounts `db-encryption-key`, `signin:<profile>:<dbId>`) | `patty` (same accounts) |
| Environment variables | `FINTRACK_AUTH`, `_DB_KEY`, `_DB_KEY_FILE`, `_DEMO`, `_HTTP`, `_LOCALE`, `_PROFILE`, `_TOKEN` | `PATTY_*` |
| MCP server names | `fintrack`, `fintrack-demo` | `patty`, `patty-demo` |
| MCP resource URIs | `fintrack://accounts`, … | `patty://accounts`, … |
| Token scopes | `fintrack:read`, `fintrack:write` | `patty:read`, `patty:write` |
| Access-token prefix | `ftk_` | `ptk_` |
| Session cookie | `fintrack_session` | `patty_session` |
| Docker volume / secret | `fintrack-data`, `fintrack_db_key` | `patty-data`, `patty_db_key` |
| Dashboard globals | `window.fintrackOnDataChanged`, `window.__fintrackCurrencies` | brand-neutral: `window.onAppDataChanged`, `window.__appCurrencies` |
| Internal markers | `<!--fintrack:auth-controls-->`, `fintrack-probe-` temp prefix | `patty:` / `patty-probe-` |

Ports stay as they are (`51737`, `51738`). The code, docs, tests, scripts, CI and Docker files carry no `fintrack`
reference after the rename, other than historical text in ADRs and designs, which records what was true then.

The dashboard globals become brand-neutral rather than `patty`-prefixed. Dashboards a user saved are stored in the
database and call these globals; a neutral name means a future rename can never break them again.

### 2. Moving an install: generic import commands, no compatibility code

The product gains the mirror of the existing export commands, `key import --from <file>` and
`db import --from <file>`. Neither knows about the old name:

- **`key import`** stores the key in the keychain entry, after proving it opens the database already at `DB_PATH` when
  there is one (otherwise only the key's format is checked). It never prints the key, refuses if an entry already
  exists, and refuses while a key file or environment variable is configured.
- **`db import`** resolves the key as the server does (never generating one), proves the snapshot opens with it, and
  places the snapshot at `DB_PATH`, owner-only (`0600`), refusing to overwrite an existing database. It does not
  migrate; the next start migrates as usual.

The order of a move is `key import`, then `db import`, then `setup <client>`.

**`key export` is kept, behind a step-up.** It adds no new capability for someone who can already run commands as
the user (they can read the keychain entry and the database themselves), but it leaves the key in a file, which can be
forgotten, synced or backed up next to the data. It stays because it is the only way to back up a keychain-held key:
a lost keychain without a copy of the key means the data is unrecoverable. It becomes a deliberate act:

- **Login password first.** The command asks for an admin's username and password (no echo) and verifies them
  against that user's stored hash, as the dashboard's step-up flows do. It refuses while the owner is unclaimed
  (there is no password to check), with the setup hint.
- **Interactive only.** No terminal, no export: there is no `--password-stdin` for this command, so it cannot be
  scripted.
- **A confirmation and a warning.** Before writing, it says what the file is, to keep it somewhere safe, never in the
  same place as a backup of the database, and to delete it once used; the person confirms.
- Unchanged: the file is `0600`, created with `wx` (never overwritten), never in the database's directory, and the
  key is never printed. A wrong password counts toward the same throttle as the other step-ups and writes nothing.

`db export` needs no step-up: the snapshot is encrypted and useless without the key. `key import` and `db import` only
write into the install and refuse to overwrite anything.

They are useful on their own: moving between machines, going from Docker back to npm, restoring a backup.

**Data cleanup on first open.** A migration in the rename PR deletes every row of `access_tokens` and `client_grants`.
Their scopes and token prefix no longer exist, so they could never authenticate again, and stored scope values that no
longer decode would break the token list. The migration names no old value: it deletes, it doesn't rewrite. Owners
create new tokens and approve new sign-ins after the move.

**The author's one-time move** is a runbook in the PR description, not product code:

1. With the old package: `key export --to …` and `db export --to …`.
2. With `@rfc0/patty`: `key import --from …`, `db import --from …`, `setup <client>`.
3. Remove the old client entry by hand, approve the new sign-in, recreate access tokens.
4. Re-save any dashboard saved under the old globals (ask the AI to update it; the bundled ones are replaced by the
   package).
5. Delete the old data directory and keychain entry once the new install shows the data.

### 3. Publishing

- **npm: staged publish with manual approval, the same process as `@rfc0/effect-runner`.**
  - The release workflow runs the full gate, then **stages** the version with `npm stage publish --access public`
    through npm trusted publishing (OIDC: no token or secret; provenance is automatic). A staged version is not
    installable and does not move `latest`.
  - The version goes live only when the owner **approves it on npmjs.com** (or `npm stage approve <id>`, which
    needs 2FA). Until then `npx @rfc0/patty@latest` keeps resolving to the previous approved version.
  - Versioning stays automatic: semantic-release still derives the version from Conventional Commits and creates
    the tag, the GitHub Release and the notes. Its npm plugin no longer publishes (`npmPublish: false`); the staged
    publish is the next step of the same workflow. (A Release created with the workflow's own token cannot trigger
    a second workflow, so effect-runner's `on: release` trigger would not fire here; the steps are the same.)
  - **A new version line, starting at `1.0.0`.** `@rfc0/patty` is a new package, so it does not continue FinTrack's
    `v4.x` numbers. semantic-release finds the last release from git tags, so the tag format changes to
    `patty-v${version}` (`.releaserc.json` `tagFormat`, and every tag lookup in `release.yml`); no existing tag
    matches it. The `v4.x` tags and GitHub Releases stay in the repository as FinTrack history; none is deleted. npm
    versions and Docker tags stay bare semver (`1.0.0`, `:1.0.0`).
  - **The first version is tagged by hand.** With no tag in the new format, the workflow's first run would put the
    whole history into the release notes. So the hand-published `1.0.0` also gets its tag `patty-v1.0.0` on the
    published commit and a GitHub Release with short hand-written notes, before the workflow is switched on; the
    workflow continues from that tag (`1.0.1`, `1.1.0`, …).
  - The trusted publisher on npmjs.com is configured for this repository and `release.yml`. npm only offers that
    setting on an existing package, so the very first version is published by hand from a terminal (2FA), as
    effect-runner's `0.2.0` was; every later version comes from the workflow.
  - The private GitHub Packages package is deleted after the move.
- **Docker: the same gate on `latest`.** The release pushes the public image `ghcr.io/rafaelfcarneiro/patty` with
  its version tag only (`:X.Y.Z`). A second job, behind a GitHub Environment (`release`) that requires the owner's
  approval, moves `:latest` to that version. Approve it after approving the npm version, so `npx …@latest` and
  `docker pull …:latest` move together.
- **GitHub:** the repository is renamed (GitHub redirects the old URL) and then made public (§4). Every link in
  README, docs, `package.json` (`repository`, `homepage`, `bugs`) and the banner points at the new repository.
- **effect-runner:** a docs-only PR there renames `docs/adr/0001-extracted-from-fintrack.md` and its mentions to the
  generic "extracted from a personal-finance app", and updates the links into this repository.

### 4. Before going public: the pre-publication scan

Making the repository public publishes its whole history. Right before that step, and not earlier:

- **Secrets:** `gitleaks detect` over every commit, including the AI-session checkpoint commits and the briefly
  committed `.claude/settings.local.json` (June 2026; at last check it held only tool-permission rules).
- **Personal data:** no real statement, account number, name or amount in any committed fixture, doc or example.
  At last check, no `.env`, database, backup, key, `.csv`, `.ofx` or `.pdf` was ever committed.
- **Nubank linkage in docs:** earlier versions of the architecture doc and the roadmap described the Diplomat
  Architecture as "Nubank's" / "a Nubank pattern". The current docs say "inspired by" and carry a not-affiliated
  note. The decision at that step: keep the history as it is, or run one narrow `git filter-repo --replace-text`
  pass over that wording. A rewrite changes almost every commit SHA (old links and quoted SHAs stop resolving), so it
  is done at most once, just before publishing.
- **The old name:** not a concern; old commits may keep it.

The history is kept (no fresh repository), subject to the scan.

## Options considered

- **Keep old names as fallbacks for a few releases** (read `FINTRACK_*` and `~/.fintrack` if the new ones are
  absent) — rejected: it keeps the old name in the product, for one known user.
- **A `migrate-from-fintrack` command** — rejected for the same reason; the generic import commands do the job.
- **Rewrite stored scope values in a migration** — rejected: the migration would have to name the old values, and
  the tokens are unusable anyway because the prefix changes.
- **Continue the `v4.x` version line** — rejected: a new package name starts its own history; continuing would
  publish `@rfc0/patty` first as `5.0.0`.
- **Delete the old `v4.x` tags to restart numbering** — rejected: destructive, and loses the history a new tag
  format keeps.
- **A fresh public repository** — not needed: the history is kept, subject to the scan.

## Consequences

- Every client config, token and stdio sign-in is reissued once. Data, users and passwords carry over.
- Saved dashboards using the old globals need re-saving once; afterwards the globals never change with the name.
- Old install commands stop working; the README and docs show only the new ones.
- `@rfc0/patty` starts at `1.0.0` under `patty-v*` tags; `v4.x` tags and Releases remain as FinTrack history.
- The rename PR is large but mechanical. Its gate includes a repository-wide check that `fintrack` appears only in
  ADR and design history.

## Plan

1. [x] Accept this ADR (2026-11-03).
2. [x] Import PR (`feat/key-db-import`, #243): `key import` / `db import` with tests, under the current names.
3. [x] Rename PR (`refactor/rename-to-patty`, #244): every name in §1, the token/grant cleanup migration, the brand-neutral
       dashboard globals (bundled dashboards and skills updated), docs, CI and Docker files, and the staged release
       workflow of §3 — **switched off** until step 7 (a repository variable gates it), so no merge publishes
       anything before the scan. Gate plus verification subagent; `grep -rni fintrack` outside `docs/adr` and
       `docs/designs` is empty.
   - [ ] Release-numbering PR (`chore/release-numbering`, §3): tag format `patty-v${version}` in `.releaserc.json`
         and `release.yml`, `docs/releasing.md` with the first-release procedure. Before step 7.
4. [ ] Key-export step-up PR (`feat/key-export-step-up`, §2): login password, interactive only, confirmation and
       warning. After the rename, so the rename stays mechanical; before step 7, so the first public version ships
       with it.
5. [ ] effect-runner docs PR (§3).
6. [ ] Pre-publication scan and the history decision (§4).
7. [ ] Rename the GitHub repository (this may happen any time before; GitHub redirects the old URL) and make it
       public. Publish `@rfc0/patty@1.0.0` by hand, push the tag `patty-v1.0.0` on that commit and create its GitHub
       Release with short notes (§3), then configure the trusted publisher on npmjs.com and the `release` environment
       on GitHub, and switch the release workflow on. From then on, each release is staged by the workflow and goes live when approved (npm, then
       Docker `latest`).
8. [ ] The author moves his install with the runbook (§2) — after step 7, since the new client entry installs
       `@rfc0/patty` from npm. Until then the old private package keeps working.
9. [ ] Delete the private GitHub Packages package.
