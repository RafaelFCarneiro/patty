# Authentication — operator guide

How FinTrack decides who may use its HTTP surface (`/api`, `/mcp`, `/ui`), how an instance gets its first login,
and what that does and doesn't protect. Decisions and rationale: [ADR-033](adr/033-authentication-and-multi-user.md).
Internals (hook, principal, tables): [`architecture.md`](architecture.md) § Authentication.
The flows as diagrams (startup, setup, login, the auth hook, logout/SSE, existing databases): [`auth-flows.md`](auth-flows.md).

> **Status: Phase 2 of 4.** This release ships the identity foundation — exactly **one user** (the *owner*), password
> login, sessions, the setup code — and **personal access tokens**: `Authorization: Bearer ftk_…` for `/api` and
> `/mcp`, with read/write scopes. MCP OAuth (Phase 3) and multiple users with per-user data (Phase 4) come later — see
> [What comes next](#what-comes-next).

## Auth modes

`FINTRACK_AUTH` is `required` or `disabled`. Leave it unset and it follows `HOST`:

| `HOST` (bind address) | `FINTRACK_AUTH` unset | `FINTRACK_AUTH=required` | `FINTRACK_AUTH=disabled` |
|---|---|---|---|
| `127.0.0.1` (default), `127.x.x.x`, `::1`, `localhost` | **disabled** | required | disabled |
| `0.0.0.0`, `::`, a LAN IP, any other name | **required** | required | **startup error** |
| any `HOST`, with `PUBLIC_URL` or `TRUST_PROXY` set | **required** | required | **startup error** |

- **`disabled`** — every request acts as the owner, with no login. This is the npm default (`HOST=127.0.0.1`): the
  server is reachable only from the machine it runs on, exactly as before authentication existed. **It only answers
  requests that say they are for this machine:** the `Host` header must name a loopback host (`127.0.0.1:port`,
  `localhost:port`, `[::1]:port` — a missing or malformed one is refused, and so is anything that is not a bare
  `host[:port]` such as `x@127.0.0.1` or `127.0.0.1/x`), and an `Origin` header, if the client sends
  one, must be a loopback origin (`http` or `https`, any port, so MCP Inspector at `http://localhost:6274` works; the
  opaque `null` is refused). Anything else is `403 forbidden_origin` on every route and method. This closes DNS
  rebinding — a page you visit resolving its own name to `127.0.0.1` so your browser sends it `Host:
  attacker.example` — and cross-site `fetch`/form requests carrying `Origin: https://evil.example`. Clients that send
  no `Origin` (native MCP clients, `curl`) are unaffected. To reach FinTrack by any other hostname, set `PUBLIC_URL`,
  which turns authentication on.
- **`disabled` ignores `Authorization` headers entirely** — every request already acts as the owner with every scope,
  so there is nothing for a token to add (and no token pages or resource metadata are served).
- **`required`** — every route except the [public surface](#the-public-surface) needs a credential: a session on
  `/ui`, a session *or* an [access token](#personal-access-tokens) on `/api` and `/mcp`. This is the container's mode
  (`HOST=0.0.0.0`).
- **`disabled` is refused at startup whenever the instance is reachable by anyone else** — a non-loopback `HOST`, or
  `PUBLIC_URL`/`TRUST_PROXY` set. A reverse proxy normally connects to a loopback bind, so `HOST=127.0.0.1` behind a
  proxy would otherwise leave the whole internet-facing site logged in as the owner; naming the proxy (`PUBLIC_URL`, or
  `TRUST_PROXY` other than `false`/`0`) turns authentication on by default instead.
- **stdio is always trusted.** The MCP client spawns the process, so there is no network caller to authenticate;
  stdio acts as the owner whatever the mode. Authentication applies to the HTTP surface only.
- With no HTTP surface running (`FINTRACK_HTTP=false` under stdio) there is nothing to protect and nothing is set up.

## Settings

| Variable | Meaning |
|---|---|
| `FINTRACK_AUTH` | `required` \| `disabled`. Default derived from `HOST`, above. |
| `PUBLIC_URL` | The external **origin** users type, e.g. `https://fintrack.example.com` — no path, no trailing slash. Optional. `https` turns on the cookie `Secure` flag; it is also the origin the [CSRF check](#csrf) expects. Phase 3 (OAuth) will require it. |
| `TRUST_PROXY` | Passed to Fastify's `trustProxy`: `true`, a hop count (`1`), or trusted addresses/CIDRs (`loopback,10.0.0.0/8`). Set it behind a reverse proxy so [login rate limiting](#brute-force-protection) sees each client's real IP instead of the proxy's. |

Invalid combinations are rejected at startup with an actionable message.

## The owner, and how an existing database is claimed

There is **exactly one owner**, and every path leads to it.

- A migration inserts the owner row — a stable id, role `admin`, **no username or password** — on **every** database,
  fresh or existing. It touches no other table; your accounts, transactions, budgets and settings are unchanged.
- The owner *is* the "default user": stdio, and requests in `disabled` mode, act as it.
- **Setup claims the owner; it never creates a user.** `/ui/setup` sets the existing owner's username and password.
  There is no code path that inserts a second user, so a database that already holds your data can never end up with
  an empty account the data doesn't belong to.

**An existing database (for example, one built up over stdio) therefore keeps all its data.** Run it with
authentication on, claim the owner with the [setup code](#the-setup-code), and log in to the data you already have.
Nothing is copied or migrated.

> Moving an npm/stdio database into the Docker volume (and exporting its keychain key) is a Phase 4 deliverable
> (`fintrack key export`). Until then, claiming works on a database file the container can already open.

## The setup code

While authentication is `required` **and** the owner has no credentials, startup prints a one-time code to
**stderr** — once the HTTP server is listening, so the URL it names is the one really bound (even with `PORT=0`).
A second process whose sidecar cannot bind (another one already owns the port) issues and prints nothing, so it
cannot replace the code you were shown (stdout carries the MCP protocol, so it is never used):

```
┌─ fintrack: first-time setup ─────────────────────────────────────────
│ This instance has no login yet. Claim it with this one-time setup code:
│
│     7QXM-4RTC-HK2V-N8WP-D3ZB
│
│ Open http://127.0.0.1:51737/ui/setup and enter the code, then choose a username and password.
```

```bash
docker compose logs fintrack        # Docker
```

- Open `/ui/setup`, enter the code, choose a **username** and a **password** (at least 12 characters, no other
  rules — a long passphrase is best). You are logged in straight away.
- The code is 100 random bits, valid for **30 minutes**, and **single use**. Only its SHA-256 is stored; the plaintext
  exists in the log line and nowhere else.
- **A restart while still unclaimed prints a fresh code and invalidates the previous one** (there is only ever one code, replaced in place — even if two processes start together, only the last one stored works). Lost the code? Restart.
- Once the owner is claimed, no code is issued, `/ui/setup` redirects to login and a POST to it is refused (`409`).
- No code is printed in `disabled` mode.

Without the code nobody can claim an exposed instance: there is no window in which "whoever gets there first" wins.

## Login, sessions, logout

- **Passwords** are hashed with **argon2id** (`@node-rs/argon2`, OWASP first-choice parameters: 46 MiB, 1 pass,
  1 lane) and verified in constant time. Usernames are case-insensitive (stored lower-cased).
- **Login** (`/ui/login`) fails with one message — "Invalid username or password." — for an unknown user, a wrong
  password, a disabled user, or the not-yet-claimed owner. An unknown username is verified against a dummy hash so it
  takes as long as a wrong password.
- A **session** is an opaque 256-bit random token in the `fintrack_session` cookie
  (`HttpOnly`, `SameSite=Lax`, `Path=/`, plus `Secure` when `PUBLIC_URL` is `https`). The database stores only the
  token's SHA-256, so reading the database yields no usable session.
- **Expiry is sliding with an absolute cap:** 7 days after last use, and never more than 30 days after login.
  The cookie itself lives for the 30-day cap and is never re-issued — the server's idle expiry is what ends a quiet
  session. Activity is recorded at most every 5 minutes. Expired sessions are deleted when they are presented, at each login,
  and at startup.
- **Logout** (the button at the bottom of the sidebar, or `POST /ui/logout`) deletes the session row, so the token is
  dead immediately — not merely forgotten by the browser.
- The `next` parameter that returns you to the page you were on is accepted only if it is a same-origin path under
  `/ui`; anything else lands on `/ui`.
- A disabled user (Phase 4) or a deleted session is rejected on the next request.

## Personal access tokens

A personal access token (PAT) lets a script or an MCP client that cannot open a browser call `/api` and `/mcp`.
Create and revoke them at **`/ui/account/tokens`** (the key icon in the dashboard sidebar; only present when authentication is
`required`).

- **Format:** `ftk_` followed by 32 random bytes, base64url (47 characters). The fixed prefix makes a leaked token
  greppable — in a repo, a log, a paste.
- **Shown once.** `POST /ui/account/tokens` answers with the plaintext on that one page. FinTrack stores only its **SHA-256**
  and a display prefix (`ftk_` + the first 6 characters) so you can tell tokens apart in the list. Lose it and you
  revoke it and create another. The plaintext is never logged: request logs redact `Authorization`, and nothing else
  receives it.
- **Name, access, expiry, and your password.** Access is *read only* or *read and write* (see [Scopes](#scopes)). Expiry is *never*, 30,
  90 or 365 days — the form defaults to 90. Creating a token asks for your **account password again**: a dashboard can
  contain a script (a write-scoped client may save one with `save_dashboard`) that runs in the dashboard's origin with
  your session cookie, but it does not know your password, so it cannot mint itself a token. A wrong password is `403` and
  counts toward the same [login rate limit](#brute-force-protection).
- **Listed with:** name, prefix, access, created, **last used**, expires and status (`active`, `expired`, `revoked`).
  `last used` is rewritten at most every 5 minutes, like a session's activity.
- **Revoke** sets `revoked_at` and keeps the row, so you can still see what existed; it takes effect on the very next
  request. Revoking twice is harmless.
- A token stops working when it is revoked, when it expires, or if its owner can no longer log in.
- **Token management is session-only.** `/ui/account/tokens` is a browser page behind the session cookie and the
  [CSRF check](#csrf). A bearer token is never accepted on `/ui`, and there is no `/api` or `/mcp` route (or MCP tool)
  that manages tokens — so a token can never mint, widen or revoke another token directly. Revoking needs no password (it only
  removes access, and you can always mint again).

### How a request authenticates

On `/api` and `/mcp` an `Authorization` header is **authoritative**:

| Request | Result |
|---|---|
| `Authorization: Bearer ftk_…`, valid | Acts as the token's user with the token's scopes. The cookie, if any, is ignored. **No CSRF check** — a bearer is not an ambient credential, a hostile page cannot make a browser attach it. |
| `Authorization` present but not a valid `Bearer ftk_…` (another scheme, unknown, revoked or expired token) | `401 invalid_token`. The session cookie is **not** tried: a bad bearer never falls back to a session. |
| No `Authorization`, valid session cookie | Acts as the owner with every scope; unsafe methods are [CSRF-checked](#csrf) as before. |
| Neither | `401` with a [challenge](#challenges). |

On `/ui` the header is ignored: a bearer there is just "no credential", so the redirect to login applies. In
`disabled` mode the header is ignored everywhere.

### Scopes

| Scope | Allows |
|---|---|
| `fintrack:read` | `GET`/`HEAD` on `/api`; every MCP tool marked read-only; MCP resources and prompts; `initialize`, `tools/list`, `ping`. |
| `fintrack:write` | Everything else on `/api` and every other MCP tool — and, by implication, everything `read` allows. |

A session and the trusted owner (stdio, auth `disabled`) hold both scopes.

- **REST:** every route definition declares its scope (`RouteDefinition.scope`); the rule is *`GET`/`HEAD` → read,
  every other method → write*, pinned by a unit test. The auth hook compares the token's scopes with the matched route's.
- **MCP:** a tool's scope comes from its `annotations.readOnlyHint` — `true` → read, otherwise write; a tool cannot be
  registered without declaring one, and a unit test lists the whole read/write split so a reclassification is a
  reviewed diff ([`mcp-tools.md`](mcp-tools.md#scopes-per-tool)). `POST /mcp` is checked **twice**: the HTTP edge reads the
  JSON-RPC body (each message, for a batch) and refuses a `tools/call` of a write tool from a read-only token before any
  tool runs; and every tool re-checks the principal the edge passed to the transport (`req.auth` → `extra.authInfo`).
  A tool the server cannot place counts as write.

### Challenges

Refusals follow [RFC 6750 §3](https://www.rfc-editor.org/rfc/rfc6750#section-3) and the MCP authorization spec, and the
`WWW-Authenticate` value is built in one place:

| Situation | Status | `WWW-Authenticate` |
|---|---|---|
| No credential on `/api`, `/mcp` | `401` | `Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="fintrack:read fintrack:write"` |
| Invalid, expired, revoked or malformed bearer | `401` | `Bearer error="invalid_token", resource_metadata="…"` |
| Token lacks the scope | `403` | `Bearer error="insufficient_scope", scope="fintrack:write", resource_metadata="…"` |

`<origin>` is `PUBLIC_URL`, else the request's own origin when it arrived at a loopback host; if neither is known
(a LAN hostname with no `PUBLIC_URL`) `resource_metadata` is left out rather than guessed.

### Protected Resource Metadata

`GET /.well-known/oauth-protected-resource/mcp` ([RFC 9728 §3](https://www.rfc-editor.org/rfc/rfc9728#section-3): the
well-known URI with the path inserted, for resource `<origin>/mcp`) and `GET /.well-known/oauth-protected-resource`
return the same document, with no credential:

```json
{
  "resource": "https://fintrack.example.com/mcp",
  "scopes_supported": ["fintrack:read", "fintrack:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "FinTrack"
}
```

`authorization_servers` is optional in RFC 9728 and absent until Phase 3 adds the in-process OAuth server;
`offline_access` is never listed. Without `PUBLIC_URL` and on a non-loopback `Host` the answer is `404` with a hint to set
`PUBLIC_URL`. Not served when authentication is `disabled`.

### Connecting a client

Send `Authorization: Bearer ftk_…` — see [`mcp-clients.md`](mcp-clients.md#docker-container-http-on-12700151737) for each client.

## The public surface

Without a session, in `required` mode, exactly these answer:

| Route | Why |
|---|---|
| `GET /api/health` | Liveness plus `db: ok \| error` — nothing else. The container `HEALTHCHECK` uses it. |
| `GET`/`POST /ui/login`, `GET`/`POST /ui/setup` | They create the session. |
| `GET /ui/assets/app.css` | The one stylesheet those two pages use. |
| `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-protected-resource/mcp` | [Protected Resource Metadata](#protected-resource-metadata) (RFC 9728): a client reads it from the 401 challenge, before it holds any token. Only in `required` mode. |

Everything else — `/api/status`, the rest of `/api`, `/mcp`, `/ui`, `/ui/events`, the other UI assets, and any path
that doesn't exist — is `401` JSON with a [`WWW-Authenticate` challenge](#challenges) (`/api`, `/mcp`, anything outside
`/ui`) or a redirect (`/ui`: to `/ui/setup` while the owner is unclaimed, otherwise to `/ui/login`). The list lives in one constant
(`PUBLIC_ROUTES`, `src/diplomat/http/authPaths.ts`), and a test enumerates every route Fastify registers to prove
nothing else is reachable.

## CSRF

A browser attaches the session cookie to any request to your instance, including ones a hostile page triggers. On top
of `SameSite=Lax`, every **unsafe** request (`POST`/`PUT`/`PATCH`/`DELETE` — including `POST /mcp`) that is authenticated
by the session cookie must declare, in `Origin` (or, failing that, `Referer`), an origin FinTrack recognises:

- `PUBLIC_URL`, when set; and
- the request's own origin **when it arrived at a loopback host** (`127.0.0.1:51737`, `localhost`) — so a local
  operator using a container's loopback port publish works without any setting.

Anything else is `403 forbidden_origin`. A non-loopback `Host` is never trusted as an origin on its own, so with no
`PUBLIC_URL` an instance reached at a LAN name refuses cookie-authenticated writes and says to set `PUBLIC_URL`.
`GET`/`HEAD` are unaffected, and so are bearer-authenticated requests (no ambient credential to forge). The pre-session `POST`s (`/ui/login`, `/ui/setup`) are checked too whenever a browser
declares an origin, so a hostile page cannot log you in as someone else; a client that declares none (`curl`, a
script) has no browser to defend.

## Brute-force protection

Login and setup are rate-limited in process, per client IP **and** per submitted username: 5 failures per username
and 20 per IP in any 15 minutes, then `429` — even for the correct password — until the window clears. A successful
login clears that username's count. Failures are counted for unknown usernames too, so the limiter reveals nothing.
Behind a reverse proxy set `TRUST_PROXY`, or every client shares the proxy's IP and 20 failed logins from anyone
lock everyone out. Prefer a **hop count** (`TRUST_PROXY=1` for one proxy) or the proxy's address/CIDR over `true`:
`true` trusts any client's `X-Forwarded-For`, which lets an attacker pick the IP the limiter sees.

## Backups made before a migration

Before applying a migration that **rewrites existing data** — Phase 1's owner insert is the first — startup
snapshots the database next to itself with SQLite's own `VACUUM INTO`:

```
<DB_PATH>.pre-<migration>.bak        e.g.  ~/.fintrack/fintrack.db.pre-0018_auth_identity.bak
```

- It is a consistent snapshot of everything committed at that moment, taken while FinTrack holds SQLite's write
  lock and applies the migration in the same transaction — so a process that is already running (even on an older
  release) cannot commit in between and be missing from it, and its writes simply wait or fail with `database is
  locked` for the instant of the upgrade. It is a standalone file (no `-wal`/`-shm` needed). It stays encrypted under the same key, mode `0600`, so it adds no
  exposure — and no value without the key.
- The path is logged to stderr (never the key). It is **not** made for a brand-new database, nor on later starts.
- To roll back: stop FinTrack, put the `.bak` back as `fintrack.db` (delete the live `-wal`/`-shm` beside it), and run
  the previous release.
- Several FinTrack processes starting at once (multiple MCP clients) take turns on an OS-level lock
  (`<DB_PATH>.migrate.lock`, a tiny companion SQLite file), so exactly one takes the backup and migrates. The lock
  dies with its holder; the file itself is harmless and is left in place.
- Delete the backup once you've confirmed the upgrade.

## Threat model so far

**Protects against**

- Another machine on your network reading or writing your finances (required mode is forced off loopback).
- A web page you visit reaching an auth-disabled instance on `127.0.0.1` — through DNS rebinding or a cross-site
  request (loopback-only `Host`/`Origin`).
- A hostile web page driving your logged-in browser (SameSite + Origin check; forms and JSON alike).
- Guessing credentials online (argon2id, rate limits, one generic error, constant-time unknown-user path).
- Someone claiming an exposed fresh instance before you (the setup code lives only in your logs).
- A leaked database file or backup yielding passwords or sessions (only hashes are stored; the database is encrypted).
- Credentials in logs (cookies, `Set-Cookie` and `Authorization` are redacted; passwords, tokens and codes are never
  logged — the one deliberate exception is the setup code's single log line).
- A leaked database yielding usable access tokens (only SHA-256 is stored; the plaintext is shown once).
- A read-only token doing anything but reading (REST route scope, MCP tool scope checked at the edge and again in the tool).
- One token minting or widening another (token management is session-only).

**Does not protect against**

- **A leaked access token.** Whoever holds a token has its scopes until it is revoked or expires — there is no IP
  binding or second factor on a bearer. Prefer *read only* where a client does not need to write, give tokens an expiry,
  keep them out of repos (the `ftk_` prefix is easy to scan for), and revoke at once if one escapes. A write token can
  do everything the owner can except manage tokens and log in. Dashboards are HTML you or an agent saved, and their
  scripts run in your browser at `/ui` with your session: a write token (or any agent you let write dashboards) can
  therefore make your *browser* act as you — read your data and call `/api` with your session — whenever you open that
  dashboard. The password prompt on token creation stops it minting a lasting credential, nothing more; treat write access
  to dashboards as access to your logged-in browser, and review a dashboard before opening one an agent wrote.
- **Anyone who can read your files.** The database key and the volume together decrypt everything; authentication
  guards the network surface, not the disk. Back up the key and the volume together, and protect both.
- **Other local programs and local web apps, with auth `disabled` on loopback.** A web page from another *site* can
  no longer reach it (the `Host`/`Origin` rule above), but any program running as any user on your machine can still
  connect to `127.0.0.1` and act as the owner. That includes a web app served from `localhost` on a *different port*
  (a dev server, a local tool): its `Origin` is loopback, which is accepted on purpose so MCP Inspector
  (`http://localhost:6274`) works. FinTrack sends no CORS headers, so such a page cannot read responses, and a
  JSON write is stopped by the browser's preflight — but a simple, body-less cross-origin `POST` is not. That is
  today's behavior and the reason `disabled` is loopback-only; turn on `FINTRACK_AUTH=required` if that matters to
  you.
- **Eavesdropping.** FinTrack serves plain HTTP. Across a network, put a TLS-terminating reverse proxy in front
  (and set `PUBLIC_URL`/`TRUST_PROXY`); Phase 3 documents and supports that deployment.
- **Username lockout.** Because failures are counted per submitted username, someone who can reach the login page can
  lock the owner's login out for 15 minutes by spamming wrong passwords (the cost of not revealing which usernames
  exist). The setup-code and session machinery are unaffected.
- **A restarted process forgetting rate-limit state.** The limiter is in memory.
- **More than one person.** There is one user; a second login cannot exist yet.
- **Eavesdropping on a token.** A bearer sent over plain HTTP across a network can be read; use TLS (Phase 3 documents the proxy deployment).

## What comes next

Phase 1 (identity) and Phase 2 (personal access tokens, scopes, Protected Resource Metadata) are done.

| Phase | Adds |
|---|---|
| 3 — MCP OAuth | An in-process OAuth 2.1 authorization server so OAuth-capable MCP clients can connect; the documented reverse-proxy + TLS deployment supersedes the loopback-only publish rule. |
| 4 — multi-user | `user_id` on every user-owned table (backfilled to the owner), per-user scoping, `FINTRACK_USER` for stdio, admin user management, and `fintrack key export` + the npm→Docker move guide. |
