# ADR-034: Authentication by default, and browser sign-in for stdio sessions

**Status:** Accepted · **Date:** 2026-10-10 · **Deciders:** Rafael · **Revises ADR-033 §1** in two places:

- the "loopback means auth `disabled`" default;
- "stdio is trusted and acts as the owner / `FINTRACK_USER`".

ADR-033's Phases 1–2 (identity, sessions, setup code, access tokens, scopes) are kept and reused. This ADR lands
**before** ADR-033 Phase 4 (multi-user), which then builds on it. Phase 3 (OAuth for remote clients) comes after
and reuses the consent and grant pieces introduced here.

## Context

After ADR-033 Phases 1–2 there are two unauthenticated paths into a local install:

1. **The HTTP sidecar on loopback** (`/ui`, `/api`, `/mcp` on `127.0.0.1`). It runs with auth `disabled`, so any
   program on the machine can read or write finances without a credential. The loopback guard stops other web
   *sites*, not local programs.
2. **The stdio channel.** It always acts as the owner.

With one user that was tolerable. With multi-user (ADR-033 Phase 4) it is not: every surface must establish
*who* is calling before deciding *which data* it may see. That includes the MCP session Claude spawns over
stdio. A stdio session that silently acts as the owner would expose every user's data to whoever's client
spawned it. A username alone (`FINTRACK_USER`, as ADR-033 planned) proves nothing.

What the MCP specification (revision 2026-07-28) says about stdio:

- **Authorization:** stdio implementations "SHOULD NOT" use the HTTP authorization flow and should "retrieve
  credentials from the environment".
- **Elicitation:** URL-mode elicitation is explicitly *not* for authorizing the client to the server ("MUST NOT
  rely on URL mode elicitation to authorize users for themselves").

So stdio sign-in has to happen outside the MCP protocol, with the resulting credential read from the environment
on later starts.

## Decision

### 1. Authentication is on by default, everywhere

- `FINTRACK_AUTH` defaults to **`required`** for every run, including the loopback sidecar of an npm/stdio install.
- `disabled` remains an **explicit** opt-out, still refused on an exposed instance, still answering only loopback
  `Host`/`Origin`. It is meant for development and tests. In this mode every request acts as the owner, and the
  docs say so plainly.
- Everything else from ADR-033 Phases 1–2 applies unchanged to the local sidecar: login, sessions, the CSRF
  check, access tokens, scopes, and the public surface.

### 2. A stdio session must sign in

When a stdio server starts, it resolves its credential in this order:

1. **`FINTRACK_TOKEN`** (env var). A personal access token, for headless use: CI, scripts, or a client config that
   should never prompt. This is the spec's "credentials from the environment" in its plainest form.
2. **A saved sign-in for this profile** in the OS keychain. **`FINTRACK_PROFILE`** (env var, default `default`)
   names the profile, so two client configs on one machine can sign in as two different users.
3. **None found:** the server is *not signed in*.
   - `initialize` and `tools/list` still work, so the client can show the server.
   - Every tool call, resource read and prompt returns an ordinary error result: *"FinTrack: not signed in.
     Open <sign-in link> and confirm the code ABCD-EFGH."*

An expired or revoked credential behaves exactly like case 3.

Once signed in, the session carries a **principal** (user, scopes, `via: stdio`), exactly like an HTTP request.
After ADR-033 Phase 4, every MCP read and write is scoped to that principal's `user_id`.

### 3. The sign-in flow (local device-style flow)

The flow is modeled on the OAuth device authorization grant (RFC 8628), run entirely inside FinTrack.

1. **The stdio process starts a pending sign-in.**
   - It creates a high-entropy **device code**. It keeps the plaintext in memory and stores only the hash.
   - It also creates a short, human-readable **user code**.
   - It stores a pending grant in a new `client_grants` table: hashes, user code, client name and version from
     `initialize`'s `clientInfo`, requested scopes, `expires_at` (10 minutes), and status `pending`.
   - Storing the grant in the database means it works even when another FinTrack process owns the HTTP port.
2. **The link carries only the user code** (`<origin>/ui/connect?code=ABCD-EFGH`). Nothing in the URL grants
   access. This follows the spec's rule against pre-authenticated URLs, and it matters because a tool result
   passes through the client and the model's context.
3. **The browser page requires a normal login** (§1 sessions). It then shows a consent screen:
   - the client name and version and when the request was made;
   - the user code, so the user can confirm it matches what the client displays;
   - a scope choice (read-only, or read and write);
   - a **duration** choice (§4);
   - a warning: "Only approve if you just asked a Claude session on this machine to connect."
4. **Approve:** the grant becomes `approved`, bound to the user who approved it, with the chosen scopes and
   duration. **Deny:** it becomes `denied`.
5. **The stdio process redeems the grant.**
   - On the next tool call (and with a short poll while a sign-in is pending), it redeems the grant with its
     device code. The device code is single-use.
   - FinTrack mints the session credential at redemption time and stores only its hash. The plaintext goes
     straight to the stdio process and never sits in the database.
   - The original tool call then proceeds.

**Phishing protection.** In a multi-user instance, user A could send the sign-in link to user B and hope B
approves it, which would hand A's client B's data. The spec describes this same attack for elicitation. The
defences:

- the user code must match what the client shows;
- the consent screen names the client and the request time, with an explicit warning;
- codes are single-use and expire in 10 minutes;
- the grant binds to whoever approved it.

**Terminal alternative:** `fintrack login [--profile <p>] [--duration <d>]` runs the same flow from a shell. It
prints the link and code, then saves the result to the keychain profile. `fintrack logout [--profile <p>]`
revokes the credential and deletes it from the keychain.

### 4. Every sign-in expires — the user chooses how soon

There is no "signed in forever". The consent screen (and `fintrack login --duration`) offers:

| Option | Behavior |
|---|---|
| **This Claude session only** | Kept in process memory only, never written to the keychain. Revoked when the process exits (best effort), with a hard cap of 12 hours in case the process dies without cleaning up. The next Claude session asks again. |
| **24 hours** (default) | Saved to the keychain profile. Expires 24 h after approval. |
| **7 days** | Saved to the keychain profile. |
| **30 days** (maximum) | Saved to the keychain profile. |

- **Expiry is absolute**, counted from approval. Use never extends it, so the user's choice is exactly what they
  get.
- When a sign-in expires, the next tool call shows a fresh sign-in link. The consent screen pre-selects the
  previous choices.
- **Every stdio sign-in is visible and revocable** under `/ui/access` (client name, profile, scopes, approved
  at, expires at, last used). Revoking takes effect on the next call.
- After ADR-033 Phase 4, an admin can lower the maximum duration for the whole instance (an instance setting).
  The user's choices are capped at that maximum. *(Built with ADR-033 Phase 4 step 2: `settings.max_sign_in_duration`, `24h | 7d | 30d`, default `30d`; the consent page offers nothing above it and approval clamps. Sign-ins already granted keep their expiry.)*

### 5. Bootstrap and recovery happen in the terminal, as part of `setup`

A sign-in link must never itself grant access (§3.2), and a setup code must never pass through a chat. So
claiming an unclaimed owner happens in the terminal.

Every database starts with an unclaimed owner (ADR-033 §7), so this applies to **every new local install**, not
only upgraded ones. It is folded into the install command users already run:

- **`npx @rafaelfcarneiro/fintrack setup [client]`** — the existing per-client setup command (Claude Code, Claude
  Desktop, Copilot, Antigravity, Codex) becomes a guided installer. In order:
  1. **Claim the owner**, if unclaimed: asks for a username and a password (confirmed). It runs the same claim
     flow as `/ui/setup`, under the ADR-033 §7 rule: claim the existing owner, never create a user. If the owner
     is already claimed, this step says so and is skipped.
  2. **Write the client's config entry**, exactly as today: idempotent merge that preserves existing keys.
     Add `FINTRACK_PROFILE` to the entry's `env` only when a non-default profile was chosen.
  3. **Offer to sign in that client now**: the §3 flow plus the §4 duration choice, saved to the profile.
     Skippable; the first tool call will ask anyway.
  - Non-interactive runs (no TTY) do not prompt. They fail step 1 with instructions, or take the password from
    stdin with `--password-stdin` for scripted installs.
  - Re-running `setup` is safe: claimed owners are skipped, configs merge, and an existing sign-in is reported
    with its expiry.
- **`fintrack auth setup`** — just step 1, for when the client config is already in place (e.g. an upgrade).
- When the owner is unclaimed, the not-signed-in message (§2) points to `npx @rafaelfcarneiro/fintrack setup`.
- **`fintrack auth reset-password [--user <u>]`** sets a new password and revokes that user's sessions, tokens and
  stdio sign-ins. This closes the "no password recovery" issue.

These commands are trusted because they open the database with the key from the OS keychain (or
`FINTRACK_DB_KEY_FILE`). Whoever can do that already controls the data, so a password prompt would add nothing.
The Docker setup code (ADR-033 §2) is unchanged.

### 6. Personal access tokens get the same rule

The PAT expiry option **"no expiry" is removed**, for consistency with §4. The choices become 30, 90 (default)
or 365 days. Existing never-expiring tokens keep working until revoked, and the UI flags them as "no expiry
(legacy)".

### 7. Printed commands are pinned, and an older build refuses a newer database

Found in the field: an unpinned `npx` resolved to a stale global install, which did not know `auth setup`, started as a server and failed in an
old seed against the newer schema. Two rules close both halves:

- **Every command FinTrack prints or documents is `@latest`-pinned**, built from one constant (`NPX_COMMAND`); `npx` with no version prefers an installed copy.
- **`bootstrap` refuses a database newer than the build** — its newest applied migration against the newest the build's journal ships — before the safety copy, migrations or
  seeding, on every entrypoint that opens the database, and unknown CLI subcommands exit non-zero with usage instead of starting a server. The guard only protects builds that include it.

## Options considered

- **Browser sign-in for stdio with chosen expiry (chosen).**
  - Gives one identity model across MCP over stdio, MCP over HTTP, REST and the UI, which multi-user needs.
  - The person signing in sets the expiry.
  - Costs: one approval step per client per expiry window, and a new table and pages.
- **`FINTRACK_USER` (ADR-033's plan) (rejected).** A name is not a credential, so any client config could claim
  any user.
- **Token in the client config only (`FINTRACK_TOKEN`) (kept as the headless path, not the default).** It works,
  but it pushes users into copying secrets into JSON files that sync and get shared. Browser sign-in keeps the
  secret in the keychain.
- **URL-mode elicitation to open the sign-in page (rejected).** The spec forbids using it for the server's own
  authorization, and client support varies. A plain link in the error result works in every client.
- **Keep stdio trusted (rejected).** Incompatible with multi-user; see Context.
- **Signed in until revoked (rejected).** The user asked for every sign-in to expire, and a forgotten saved
  credential is a liability.

## Consequences

- **Zero-config is gone.** A fresh local install claims the owner during
  `npx @rafaelfcarneiro/fintrack setup`, the command it already runs to configure its client. Each Claude client then signs in
  through the browser per its chosen window.
  - Upgrading installs (including the maintainer's): the first tool call after the upgrade answers "not signed
    in".
  - The message points to `fintrack auth setup` while the owner is unclaimed, and to the sign-in link once it
    is claimed.
  - Data is untouched.
- **The browser sign-in needs the HTTP sidecar.** With `FINTRACK_HTTP=false`, use `FINTRACK_TOKEN`, or run
  `fintrack login`, which starts a temporary loopback server for the duration of the sign-in.
- **The honest limit stays documented.** On one OS account, anyone who can run FinTrack can read the key and the
  database directly. Sign-in separates users *through FinTrack*; it is not a wall against your own OS account.
- **New pieces:** the `client_grants` table, a credential kind for stdio sign-ins (in `access_tokens` or a
  sibling table; decided in implementation), `/ui/connect`, the `/ui/access` listing, keychain profile storage,
  and the CLI commands (`auth setup`, `auth reset-password`, `login`, `logout`).
- **Reused by ADR-033 Phase 3:** the consent screen, approve/deny, and the grant-then-redeem mechanics are the
  same building blocks as OAuth's authorization-code flow.
- **ADR-033 updates in the same change:**
  - §1: the default becomes `required`; stdio requires sign-in; `FINTRACK_USER` is dropped.
  - Phase 4: stdio identity comes from this ADR.
  - `docs/auth.md`, `docs/auth-flows.md` (new diagrams: stdio sign-in, expiry/re-sign-in), `mcp-clients.md`,
    CLAUDE.md, README.

## Migration plan

1. **`feat/auth-default-and-cli`**
   - Default `FINTRACK_AUTH=required`.
   - `setup [client]` gains the owner-claim step (§5); the CLI commands `fintrack auth setup` and
     `fintrack auth reset-password`.
   - PAT expiry without "never".
   - stdio still runs as the owner in this step, and keeps working.
2. **`feat/stdio-sign-in`**
   - `client_grants`, `/ui/connect` consent, duration choices, redeem, keychain profiles, the not-signed-in
     results, `fintrack login`/`logout`, `/ui/access` listing and revoke.
   - `setup [client]` gains its optional sign-in step (§5.3).
   - stdio stops acting as the owner.
3. ADR-033 Phase 4 (multi-user) builds on the principal resolved here.

## Action Items

1. [x] Review/accept this ADR (accepted 2026-10-10).
2. [x] Step 1 — auth on by default, terminal setup and reset, PAT expiry (branch `feat/auth-default-and-cli`).
3. [x] Step 2 — stdio browser sign-in with chosen expiry (branch `feat/stdio-sign-in`).
4. [x] Update ADR-033 §1 and its Phase 4 notes to point here (done with step 1).

**Implementation notes (step 2)** — decided while building, none of them changing a decision above:

- A stdio sign-in is an `access_tokens` row (`kind: stdio`, plus `client_name` and `profile`), so there is one authenticate path, one revoke and one listing. It is
  admitted **only on the stdio channel** (`PrincipalVia.stdio`): presented as a bearer on `/api` or `/mcp` it is `401`, so a credential copied from the keychain is not
  also a key to the HTTP surface.
- `client_grants` also records `approved_at` (the expiry is absolute from approval, and redemption can come minutes later), the `channel` that asked (`stdio` | `cli` —
  "this session only" is offered only to a stdio client, and refused server-side for `fintrack login`), and the asker's `hint_access`/`hint_duration` (what
  `fintrack login --scope/--duration` pre-select on the consent page; the person still chooses).
- The consent page and the access listing live under `/ui/connect` and the existing `/ui/access/tokens` page (a stdio table above the personal access tokens): `/ui/access`
  alone would collide with the one-segment dashboard namespace.
- Startup refuses a database a newer build has migrated (the version guard) and every printed command is `@latest`-pinned — see `docs/releasing.md`.

Both steps are feature-sized and security-sensitive. Each gets the DoD verification subagent plus a
`security-review` pass. The verifier is charged with:

- no unauthenticated path to data on any surface except explicit `disabled`;
- no sign-in URL that grants access by itself;
- no credential stored or logged in plaintext;
- every stdio sign-in expires within its chosen window, and "this session only" never touches the keychain.
