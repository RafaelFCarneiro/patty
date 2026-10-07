# ADR-033: Authentication and multi-user — UI login, access tokens, MCP OAuth, per-user data

**Status:** Accepted · **Date:** 2026-10-06 · **Deciders:** Rafael · Closes the gate ADR-032 left open: until
this lands, a FinTrack HTTP surface is safe only on host loopback. Builds on ADR-007 (stdio default), ADR-013
(HTTP sidecar: REST + `/ui`), ADR-021/029 (write path, idempotency), ADR-024 (single-process SQLite), ADR-032
(container image). The MCP authorization requirements below follow the MCP specification revision
**2026-07-28** (`basic/authorization`); re-check the then-current revision when each phase starts.

## Context

FinTrack's HTTP surface (`/api`, `/mcp`, `/ui`) has **no authentication**. Everything assumes one person on one
machine: stdio is spawned by that person, and the sidecar binds `127.0.0.1`. ADR-032 made FinTrack runnable as a
standalone container, which raises two needs that the loopback-only rule postponed:

1. **Exposure beyond the host** (LAN, a home server, a VPS behind a reverse proxy) requires every HTTP request to
   be authenticated.
2. **More than one person per instance.** A household or a small group should be able to share one deployment,
   with each person seeing only their own finances.

There are three kinds of caller, each authenticating differently:

- **A person in a browser** (`/ui` dashboards and the REST calls they make).
- **An MCP client.** Some clients can run an OAuth browser flow. Others, and scripts, can only send a static
  header.
- **stdio.** The process is spawned by the user, so there is no network caller. The MCP spec says stdio
  "SHOULD NOT" use the HTTP authorization flow and should take credentials from the environment instead.

The data model has no notion of a user. Every aggregate is global, and there is one `settings` singleton.

## Decision

Add **identity** (users, password login, sessions), **access tokens** (personal access tokens and OAuth),
**MCP authorization** (spec-compliant), and **tenancy** (every user-owned row is scoped to a user). These ship in
phases (see below). Local npm behavior stays zero-config.

### 1. Auth mode and exposure

- New setting **`FINTRACK_AUTH`**, either `required` or `disabled`.
  - The default is derived from `HOST`: loopback means `disabled`, anything else means `required`.
  - `disabled` together with a non-loopback `HOST` is a **startup error**: the API is never unauthenticated on
    a reachable interface.
  - The npm sidecar (loopback) keeps today's zero-config behavior. The container (`HOST=0.0.0.0`) requires auth
    by default.
- With auth `disabled`, every request acts as the **default user**: the **owner**, a single admin row created
  by migration on every database, fresh or existing (§7).
- **stdio is trusted** (spec-aligned). It acts as the default user, or as `FINTRACK_USER` (a username) once an
  instance has more than one user. With several users and no `FINTRACK_USER`, startup fails with an actionable
  message.
- **HTTPS beyond loopback.** FinTrack does not terminate TLS. Non-loopback exposure goes through a reverse
  proxy (Caddy or Traefik, for example). A new **`PUBLIC_URL`** setting (the external `https://` origin) is
  required when auth is `required` and OAuth is on. It is the OAuth issuer and the MCP canonical resource URI,
  and it decides whether cookies get the `Secure` flag. Fastify `trustProxy` is configurable for the proxy hop.
- **ADR-032's exposure policy is superseded.** After Phase 3 lands, a non-loopback publish is supported **only**
  with auth `required`, `PUBLIC_URL` set, and TLS at the proxy. All docs and the `compose.yaml` comments change
  in the same phase.

### 2. Identity and UI login

- **`users`** table: `id`, `username` (unique, case-insensitive), `password_hash`, `role` (`admin|member`),
  `created_at`, `disabled_at`.
  - Passwords are hashed with **argon2id** (`@node-rs/argon2`, prebuilt glibc/darwin binaries) using
    OWASP-recommended parameters.
  - Password policy: length ≥ 12; no composition rules.
- **Bootstrap without an open claim window.** When auth is `required` and **the owner has no credentials
  yet** (a fresh database, or an existing stdio database, §7), startup prints a one-time **setup code** to
  stderr (the container log).
  - Only the code's hash is stored, and it expires.
  - `/ui/setup` accepts it to **claim the owner**: it sets the owner's username and password and never creates
    a separate user.
  - Without the code, nobody can claim an exposed instance.
- **Sessions.**
  - The session token is an opaque random 256-bit value. Only its SHA-256 is stored, in a `sessions` table
    (`user_id`, `expires_at`, `last_seen_at`).
  - The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` when `PUBLIC_URL` is https.
  - Expiry is sliding, with an absolute maximum.
  - Logout deletes the row.
- **CSRF.** For cookie-authenticated unsafe methods, FinTrack checks `Origin` (against `PUBLIC_URL`, or the
  request host on loopback) on top of `SameSite`. Bearer-authenticated requests are exempt, since they carry no
  ambient credential.
- **Brute force.** Login and setup are rate-limited per IP and per username, with a constant-time
  user-not-found path.
- **User management.** Admins create, disable, and reset users from the UI. There is no self-registration.

### 3. Personal access tokens (REST + MCP)

- **`access_tokens`** table: `id`, `user_id`, `name`, `token_hash` (SHA-256), `prefix` (for display), `scopes`,
  `created_at`, `last_used_at`, `expires_at?`, `revoked_at?`.
  - The token value is shown **once** at creation and never stored.
  - The token format is `ftk_<random>`, which makes leaked tokens greppable.
- Tokens are sent as `Authorization: Bearer …` on `/api` and `/mcp`. The **issuer is FinTrack's own
  authorization server** (§4), so a PAT is a pre-provisioned token from the server's own AS. That keeps it
  within the spec rule that an MCP server accepts only tokens issued for it.
- **Scopes:** `fintrack:read` and `fintrack:write` (write implies read).
  - Every MCP tool and REST route declares the scope it needs.
  - A read-only token calling a write tool gets HTTP 403 with
    `WWW-Authenticate: Bearer error="insufficient_scope", scope="fintrack:write", resource_metadata=…`.
- Tokens are created and revoked in the UI.

### 4. MCP authorization (OAuth 2.1, in-process authorization server)

FinTrack is both the **resource server** (`/mcp`, `/api`) and a minimal **authorization server**, mounted on
the same Fastify instance. The MCP spec allows the AS to be co-hosted.

**Resource server**

- Serve **Protected Resource Metadata** (RFC 9728, MUST) at `/.well-known/oauth-protected-resource`. It lists
  `PUBLIC_URL` as the issuer, the canonical resource (`<PUBLIC_URL>/mcp`), and `scopes_supported`. Per the
  spec, `offline_access` is not listed there.
- An unauthenticated `/mcp` request gets **401** with `WWW-Authenticate: Bearer resource_metadata="…",
  scope="fintrack:read fintrack:write"`.
- Validate **audience**: a token must have been issued for this resource (RFC 8707). Tokens go only in the
  header, never in a query string.

**Authorization server**

- **AS Metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`.
- `/oauth/authorize`:
  - authorization code + **PKCE S256 only**;
  - `resource` is required;
  - login uses the §2 session, followed by a **consent screen** that names the client and its scopes;
  - the response includes `iss` (RFC 9207) and advertises `authorization_response_iss_parameter_supported`.
- `/oauth/token`: code exchange and **rotating refresh tokens** with reuse detection.
  - Access tokens are short-lived and opaque, stored hashed with their audience, scopes, and user.
- **Client registration:**
  - **Client ID Metadata Documents** (spec SHOULD) as the primary mechanism. The AS fetches the client's HTTPS
    metadata URL behind an **SSRF guard**: HTTPS only, no private/loopback/link-local targets, size and time
    limits, and caching.
  - **Dynamic Client Registration** (RFC 7591, deprecated but still common in clients) is a configurable
    fallback, on by default and rate-limited.
  - Redirect URIs must be exact-match, and either HTTPS or a loopback http URI.
- **Implementation choice is a Phase-3 spike, not decided here.** Options: hand-roll on Fastify with zod at
  every endpoint, adapt the MCP TypeScript SDK's server-side auth helpers, or use a maintained OAuth server
  library. Criteria: spec conformance (CIMD, `iss`, resource indicators), Fastify fit, and no session state
  outside SQLite.

### 5. Tenancy (multi-user data)

Isolation is **logical (row-level) inside one encrypted database**, not cryptographic. There is one DB key per
instance, and whoever holds the key and the volume can read every user's data. The docs state this plainly.
Per-user encryption is out of scope.

- **User-owned aggregates gain a non-null `user_id`:** `accounts`, `credit_cards`, `bills`, `transactions`,
  `transaction_tags` (via its parent rows), `tags`, `budgets`, `recurring_rules`, `dashboards`, `merchants`,
  and `merchant_category`.
- **User categories** gain `user_id`. **Seeded default categories stay shared** (`user_id` null, read-only,
  translated via ADR-009).
- **Shared reference data:** `currencies` and `currency_rates` (market data).
- **`settings` splits** into instance settings (singleton) and per-user preferences (`locale`, base currency;
  ADR-026/FD-021).
- **One request-scoped principal** (`{ userId, scopes }`) is resolved in the diplomat layer from the cookie,
  bearer token, or stdio/disabled default. It is passed into controllers as an explicit argument, never read
  from ambient state. Controllers pass `userId` to repos, every repo query filters on it, and every insert sets
  it.
  - This is boundary data like any other input. `logic/` stays pure.
  - ADR-028 is unchanged: user scoping is a filter on a repo's own table, not cross-aggregate correlation.
- **Cross-user references are impossible by construction.** Entity resolvers (`controllers/resolve.ts`)
  resolve only within the principal's user, so another user's id is reported as "not found", never
  "forbidden", and existence doesn't leak.
- **Idempotency stays domain-derived (ADR-029 2b), and its derivation does not change.** Uniqueness becomes
  `UNIQUE(user_id, idempotency_key)`, so two users importing the same statement don't collide. `userId` is
  deliberately **not** added to the hash: every existing key stays valid, and re-importing an old statement
  still dedups against the rows already in the database (see §7).
- **The change bus** carries `userId` on every event. SSE/UI subscribers receive only their own user's events.
- **The recurring scheduler** materializes due rules per user. One process still serves all users (ADR-024 is
  unchanged).
- **Migration of existing data:** every existing row is assigned to the **owner** user (§7). No data is lost
  or duplicated.
- **Until tenancy lands, an instance has exactly one user.** The "create user" action is disabled in Phases 1–3,
  so a second login can never see the first user's data.

### 6. Unauthenticated surface (deliberately minimal)

- `/api/health` stays public. It is extended to report liveness plus `db: ok|error` and nothing else.
- The Docker `HEALTHCHECK` moves from `/api/status` to `/api/health`.
- `/api/status` (version, locale) requires auth.
- `/.well-known/*`, `/oauth/*`, `/ui/login`, and `/ui/setup` are public, along with the static assets they need.

### 7. Existing data (databases created before users existed)

Real databases already exist: populated through stdio, with every row global and nobody owning it. They
must come through every phase with **no data loss and no loss of access**, whether the instance stays on
npm/stdio or moves to Docker. The design hangs on one rule: **there is exactly one owner user, and every path
leads to it.** No path creates a second, empty user that the data doesn't belong to.

- **The owner row is created by migration, not by setup.**
  - Phase 1's migration inserts a single **owner** user with a stable id (a named constant), role `admin`, and
    **no credentials yet** (`password_hash` null). It does this on every database, fresh or existing.
  - The owner is the "default user" of §1, so stdio and auth-`disabled` requests act as the owner.
- **Setup claims the owner; it never creates a new user.**
  - A setup code is issued when auth is `required` and **the owner has no credentials**, not when the users
    table is empty.
  - `/ui/setup` sets the owner's username and password.
  - An existing stdio database that later runs with auth `required` gets a setup code, the person claims the
    owner, and they log in to the data they already have.
- **Tenancy backfills to the owner.**
  - Phase 4's migration adds `user_id`, sets it to the owner's id on every existing row, and only then makes it
    `NOT NULL`. This happens in one migration, inside a transaction.
  - Idempotency keys are untouched (§5).
  - A post-migration check asserts that no user-owned row has a null or unknown `user_id`. Startup refuses to
    continue otherwise, with no partial state.
- **Safety copy before data-rewriting migrations.**
  - Before applying a migration flagged as rewriting existing rows (Phase 1's owner insert, Phase 4's backfill),
    startup checkpoints the WAL and writes `fintrack.db.pre-<migration>.bak` next to the database. That's the
    same encrypted file under the same key, so it adds no new exposure.
  - The log line names the backup path.
  - The migration is also rehearsed against a copy of a real database before the phase merges (see the
    migration plan).
- **Moving an npm/stdio database to Docker.** The data and the key have to travel together.
  - The key lives in the OS keychain (service `fintrack`, account `db-encryption-key`), and the container
    can't read a keychain.
  - A **`fintrack key export --to <file>`** command (owner-only file mode, refusing to overwrite) writes it to a
    file usable as `FINTRACK_DB_KEY_FILE`.
  - Stop the stdio process, copy `fintrack.db` (after the WAL checkpoint the command performs) into the
    `fintrack-data` volume, start the container with the exported key, then claim the owner with the setup
    code.
  - `docs/auth.md` documents this as a step-by-step guide, including a verification step: the claimed account
    shows the existing accounts and transactions.

## Options considered

- **Multi-user (chosen)** vs a single owner. The user chose multi-user so one deployment can serve a household or
  small group. The cost is a schema-wide `user_id` and per-user scoping in every repo, so tenancy is phased last,
  after identity exists, and user creation stays locked until it lands.
- **Logical isolation in one DB (chosen)** vs a database (and key) per user. Per-user DB files would give
  cryptographic separation, but they multiply migrations, connections, the scheduler, and backups, and they
  break the one-volume model from ADR-032.
- **PATs + OAuth (chosen)** vs OAuth only or tokens only. PATs work with every client and script today. OAuth
  gives spec-compliant browser login for clients that implement it. Both are issued by FinTrack's own AS, so
  the "only tokens issued for this server" rule holds.
- **In-process AS (chosen)** vs an external IdP (Keycloak, Authentik). An external IdP is overkill for a
  self-hosted personal app and adds a second service. Pointing PRM at an external AS remains possible later.
- **Password + session (chosen)** vs passkeys first. WebAuthn needs a secure context, which hurts LAN setups.
  Passkeys and TOTP are follow-ups.
- **Auth disabled on loopback (chosen)** vs always on. Always-on would break today's zero-config npm dashboards.
  Disabling auth on a non-loopback host is impossible by config validation.

## Consequences

- **New tables:** `users`, `sessions`, `access_tokens`, `setup_codes`, and the OAuth tables (clients, auth
  codes, refresh-token families). Tenancy adds `user_id` across user-owned tables plus composite uniques.
- **New config:** `FINTRACK_AUTH`, `PUBLIC_URL`, `FINTRACK_USER`, and the trust-proxy setting. These are
  validated together; the invalid combinations above are startup errors.
- **Every controller signature gains the principal.** This is mechanical but wide, and the tenancy phase is the
  largest change since the write-path conversion.
- **Security-sensitive code enters the repo** (hashing, sessions, OAuth). Each phase gets a focused security
  review (the `security-review` skill) on top of the DoD verifier.
- **Docker users log in** (auth is required in the image) after a one-time setup code from the logs.
- **Docs:** `docs/architecture.md` (auth model, principal threading, tenancy invariants, schema), a new
  `docs/auth.md` (operator guide: setup code, users, tokens, reverse proxy + TLS, threat model), `mcp-clients.md`
  (bearer and OAuth per client), `mcp-tools.md` (per-tool scope), README/`compose.yaml` (exposure policy),
  `CLAUDE.md` data conventions (`user_id` on writes, idempotency uniqueness).

## Migration plan (phased — each behind the full gate + security review)

1. **`feat/auth-identity`**
   - Ships: `FINTRACK_AUTH`/`PUBLIC_URL`/trust-proxy config with combination validation; `users` and
     `sessions`; the **owner row inserted by migration** on every database, with the pre-migration safety copy
     (§7); argon2id; the setup code that claims the owner; `/ui/login`, `/ui/setup`, logout; session middleware on `/api`,
     `/ui`, `/mcp`; CSRF origin check; login rate limit; the minimal public surface (§6) and the `HEALTHCHECK`
     move.
   - Single user only. MCP over HTTP with auth `required` is temporarily reachable only with a session cookie,
     which is acceptable because PATs arrive next.
2. **`feat/auth-access-tokens`**
   - Ships: PATs (create/list/revoke UI); bearer auth on `/api` and `/mcp`; scopes on every tool and route;
     401/403 `WWW-Authenticate` with `resource_metadata`; Protected Resource Metadata.
   - `mcp-clients.md`: connect with a bearer header.
3. **`feat/auth-mcp-oauth`**
   - Starts with the implementation spike (§4).
   - Ships: AS metadata, authorize + consent, token + refresh rotation, CIMD with SSRF guard, DCR fallback,
     `iss`, audience binding.
   - The exposure policy flips: documented reverse-proxy + TLS deployment, `compose.yaml` comments updated.
   - Verified against at least one real OAuth-capable MCP client.
4. **`feat/multi-user-tenancy`**
   - Ships: `user_id` on every user-owned table, backfilled to the owner, with the safety copy and the
     post-migration integrity check (§7); the principal threaded
     through every controller and repo; resolvers scoped per user; per-user idempotency uniqueness; the
     settings split; a per-user change bus and scheduler; `FINTRACK_USER` for stdio; admin user management
     unlocked.
   - Ships: `fintrack key export`, and the npm→Docker move guide in `docs/auth.md` (§7).
   - Tests:
     - a cross-user isolation suite that hits every read and write path as user B against user A's ids and
       expects not-found;
     - a backfill test on a pre-tenancy fixture database: every row is owned by the owner, balances and
       summaries are identical before and after, and re-importing an old statement still dedups.
   - Before merge, rehearse the migration on a **copy** of a real database.

## Action Items

1. [x] Review/accept this ADR (accepted 2026-10-06).
2. [ ] Phase 1 — identity, sessions, UI login, setup code, auth mode.
3. [ ] Phase 2 — personal access tokens, scopes, protected resource metadata.
4. [ ] Phase 3 — in-process OAuth 2.1 AS for MCP; non-loopback exposure supported behind TLS.
5. [ ] Phase 4 — multi-user tenancy.

Every phase is feature-sized (schema + multiple layers + security-sensitive). Each gets the DoD verification
subagent, charged with checking that:

- no route is reachable without a principal outside §6;
- no credential (password, session, token, setup code, refresh token) is stored or logged in plaintext;
- npm loopback behavior is unchanged.

Each phase also gets a `security-review` pass. Phase 4 adds one more check for the verifier: no repo query
lacks the `user_id` filter.
