# Authentication — operator guide

How FinTrack decides who may use its HTTP surface (`/api`, `/mcp`, `/ui`), how an instance gets its first login,
and what that does and doesn't protect. Decisions and rationale: [ADR-033](adr/033-authentication-and-multi-user.md).
Internals (hook, principal, tables): [`architecture.md`](architecture.md) § Authentication.
The flows as diagrams (startup, setup, login, the auth hook, logout/SSE, existing databases): [`auth-flows.md`](auth-flows.md).

> **Status: Phase 2 of 4, plus [ADR-034](adr/034-local-auth-and-stdio-sign-in.md) step 1.** This release ships the
> identity foundation — exactly **one user** (the *owner*), password login, sessions, the setup code — and **personal
> access tokens**: `Authorization: Bearer ftk_…` for `/api` and `/mcp`, with read/write scopes. **Authentication is now on by
> default, on every install** — a local npm one included — and the owner is claimed in the terminal during
> `setup` ([First setup](#first-setup)). The stdio channel still acts as the owner (its browser sign-in is ADR-034
> step 2). MCP OAuth (Phase 3) and multiple users with per-user data (Phase 4) come later — see
> [What comes next](#what-comes-next).

## Auth modes

`FINTRACK_AUTH` is `required` or `disabled`. **Unset, it is `required` — everywhere**, the loopback sidecar of a local
npm/stdio install included (ADR-034 §1). `disabled` is an explicit opt-out for development and tests, and only
possible on a loopback bind:

| Situation | `FINTRACK_AUTH` unset | `FINTRACK_AUTH=required` | `FINTRACK_AUTH=disabled` |
|---|---|---|---|
| `HOST` loopback (`127.0.0.1` default, `127.x.x.x`, `::1`, `localhost`), no `PUBLIC_URL`/`TRUST_PROXY` | **required** | required | allowed (explicit, loopback-only) |
| `HOST` `0.0.0.0`, `::`, a LAN IP, any other name | **required** | required | **startup error** |
| any `HOST`, with `PUBLIC_URL` or `TRUST_PROXY` set | **required** | required | **startup error** |

- **`required`** — every route except the [public surface](#the-public-surface) needs a credential: a session on
  `/ui`, a session *or* an [access token](#personal-access-tokens) on `/api` and `/mcp`. The first time, the owner has no
  login yet: [claim it](#first-setup) in the terminal, or with the [setup code](#the-setup-code) in the browser.
- **`disabled`** — every request acts as the owner, with no login: any program on your machine can read and write
  your finances through `127.0.0.1`. Use it for development and tests, not as a way to avoid the login. **It only answers
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
- **`disabled` is refused at startup whenever the instance is reachable by anyone else** — a non-loopback `HOST`, or
  `PUBLIC_URL`/`TRUST_PROXY` set. A reverse proxy normally connects to a loopback bind, so `HOST=127.0.0.1` behind a
  proxy would otherwise leave the whole internet-facing site logged in as the owner.
- **stdio still acts as the owner** whatever the mode: the MCP client spawns the process, so there is no network caller
  to authenticate. Authentication applies to the HTTP surface only *in this release*; making a stdio session sign in is
  [ADR-034 step 2](adr/034-local-auth-and-stdio-sign-in.md#2-a-stdio-session-must-sign-in).
- With no HTTP surface running (`FINTRACK_HTTP=false` under stdio) there is nothing to protect and nothing is set up.

## Settings

| Variable | Meaning |
|---|---|
| `FINTRACK_AUTH` | `required` \| `disabled`. Default `required`, on every surface; `disabled` is loopback-only. See [Auth modes](#auth-modes). |
| `PUBLIC_URL` | The external **origin** users type, e.g. `https://fintrack.example.com` — no path, no trailing slash. Optional. `https` turns on the cookie `Secure` flag; it is also the origin the [CSRF check](#csrf) expects. Phase 3 (OAuth) will require it. |
| `TRUST_PROXY` | Passed to Fastify's `trustProxy`: `true`, a hop count (`1`), or trusted addresses/CIDRs (`loopback,10.0.0.0/8`). Set it behind a reverse proxy so [login rate limiting](#brute-force-protection) sees each client's real IP instead of the proxy's. |

Invalid combinations are rejected at startup with an actionable message.

## The owner, and how an existing database is claimed

There is **exactly one owner**, and every path leads to it.

- A migration inserts the owner row — a stable id, role `admin`, **no username or password** — on **every** database,
  fresh or existing. It touches no other table; your accounts, transactions, budgets and settings are unchanged.
- The owner *is* the "default user": stdio, and requests in `disabled` mode, act as it.
- **Setup claims the owner; it never creates a user.** `/ui/setup` and `fintrack auth setup` both set the existing
  owner's username and password. There is no code path that inserts a second user, so a database that already holds your
  data can never end up with an empty account the data doesn't belong to.

**An existing database (for example, one built up over stdio) therefore keeps all its data.** Upgrade, claim the owner
once ([First setup](#first-setup)), and log in to the data you already have. Nothing is copied or migrated.

> Moving an npm/stdio database into the Docker volume (and exporting its keychain key) is a Phase 4 deliverable
> (`fintrack key export`). Until then, claiming works on a database file the container can already open.

## First setup

Every database starts with an unclaimed owner, so every new local install claims it once. It is folded into the
command you already run to connect a client:

```bash
npx @rafaelfcarneiro/fintrack@latest setup claude-code     # or claude-desktop, copilot, antigravity, codex
```

In order, it:

1. **Claims the owner**, if nobody holds its login yet. It asks for a **username**, then a **password** twice, with no
   echo (a bad answer is asked again, three tries at most; the rules are the ones `/ui/setup` applies — a password of at
   least 12 characters, no other rules). If the owner is already claimed it says so in one line and skips the step.
2. **Writes the client's config entry** exactly as before: an idempotent merge that keeps your other keys.

`fintrack auth setup` is just step 1, for when the client is already configured (an upgrade, a second machine's
config…). Run either as often as you like.

```bash
npx @rafaelfcarneiro/fintrack@latest auth setup
```

- **Scripted installs.** With no terminal there is nothing to ask, so the command fails with instructions —
  *before* it writes any config — instead of hanging. Give it the username and pipe the password in:
  `printf %s "$PASSWORD" | npx @rafaelfcarneiro/fintrack@latest setup claude-code --username rafael --password-stdin`
  (stdin must be a pipe or a file, not a terminal).
- **An upgrade keeps its data.** Authentication is now on by default, so after upgrading the browser dashboard
  (`/ui`) asks for a login. Run `auth setup` (or `setup <client>` again) **once**: it claims the existing owner, and the
  accounts and transactions you already have are what you see after logging in. Nothing is copied or migrated, and a
  pre-migration backup is still made where a migration rewrites data (see [Backups](#backups-made-before-a-migration)).
- **It never creates a user and never starts a session.** The claim updates the one owner row, spends any setup code still
  outstanding in the same write (so it cannot claim anything afterwards), and does not log you in: sign in at `/ui/login`.
- **Why a terminal, and why no code.** These commands open the database with its key from the OS keychain (or
  `FINTRACK_DB_KEY_FILE`/`FINTRACK_DB_KEY`) and neither start HTTP nor stdio. Whoever can do that already controls the
  data, so a code or a current password would add nothing — the terminal is the proof. A sign-in *link* must never itself
  grant access, and a setup code must never pass through a chat.
- **The Docker setup code is unchanged** — the container prints it; open `/ui/setup`.
- The password is never printed or logged and is stored only as an argon2id hash.

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
│ Open http://127.0.0.1:51737/ui/setup and enter the code, then choose a username and password,
│ or run `npx @rafaelfcarneiro/fintrack auth setup` in a terminal.
```

```bash
docker compose logs fintrack        # Docker
```

- Open `/ui/setup`, enter the code, choose a **username** and a **password** (at least 12 characters, no other
  rules — a long passphrase is best). You are logged in straight away. The page and the banner both also name the
  terminal route, [`auth setup`](#first-setup): a stdio-spawned process's stderr lands in the client's log files, where
  the code is hard to find.
- The code is 100 random bits, valid for **30 minutes**, and **single use**. Only its SHA-256 is stored; the plaintext
  exists in the log line and nowhere else.
- **A restart while still unclaimed prints a fresh code and invalidates the previous one** (there is only ever one code, replaced in place — even if two processes start together, only the last one stored works). Lost the code? Restart.
- Once the owner is claimed — by the code or from the terminal — no code is issued, `/ui/setup` redirects to login and a POST to it is refused (`409`).
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

## Reset a password

There is no recovery email; recovery is a terminal command, trusted the same way as [`auth setup`](#first-setup):

```bash
npx @rafaelfcarneiro/fintrack@latest auth reset-password            # the owner (the only user for now)
npx @rafaelfcarneiro/fintrack@latest auth reset-password --user ana # a named user (Phase 4)
```

It asks for the new password twice, no echo (or `--password-stdin`), then in **one write**:

- replaces that user's password hash;
- **deletes every session** of that user (their browsers are logged out on the next request);
- **revokes every still-live access token** of that user (`revoked_at` is set and the rows are kept, so the list still
  shows what existed).

It prints how many sessions ended and tokens were revoked. A session created by a login in the instant between the command reading the user's sessions and committing is not ended by that run; run it again if the server was busy. Other users' rows are never touched. An unknown `--user` is a
clear error before any password is asked; an unclaimed owner is pointed at `auth setup`.

## Personal access tokens

A personal access token (PAT) lets a script or an MCP client that cannot open a browser call `/api` and `/mcp`.
Create and revoke them at **`/ui/access/tokens`** (the key icon in the dashboard sidebar; only present when authentication is
`required`).

- **Format:** `ftk_` followed by 32 random bytes, base64url (47 characters). The fixed prefix makes a leaked token
  greppable — in a repo, a log, a paste.
- **Shown once.** `POST /ui/access/tokens` answers with the plaintext on that one page. FinTrack stores only its **SHA-256**
  and a display prefix (`ftk_` + the first 6 characters) so you can tell tokens apart in the list. Lose it and you
  revoke it and create another. The plaintext is never logged: request logs redact `Authorization`, and nothing else
  receives it.
- **Name, access, expiry, and your password.** Access is *read only* or *read and write* (see [Scopes](#scopes)). Expiry is 30,
  90 or 365 days — the form defaults to 90, and there is **no "never"** (ADR-034 §6). Creating a token asks for your **login password again**: a dashboard can
  contain a script (a write-scoped client may save one with `save_dashboard`) that runs in the dashboard's origin with
  your session cookie, but it does not know your password, so it cannot mint itself a token. A wrong password is `403` and
  counts toward the same [login rate limit](#brute-force-protection).
- **Listed with:** name, prefix, access, created, **last used**, expires and status (`active`, `expired`, `revoked`).
  `last used` is rewritten at most every 5 minutes, like a session's activity.
- **Legacy tokens.** A token created before ADR-034 may have no expiry. It keeps working until it is revoked, and the
  list shows it as **"No expiry (legacy)"** — revoke it and mint a new one when convenient. New tokens always expire.
- **Revoke** sets `revoked_at` and keeps the row, so you can still see what existed; it takes effect on the very next
  request. Revoking twice is harmless.
- A token stops working when it is revoked, when it expires, or if its owner can no longer log in.
- **Token management is session-only.** `/ui/access/tokens` is a browser page behind the session cookie and the
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
- **Other local programs and local web apps using the HTTP surface** (a script, a dev server on another port): with the
  default `required`, `127.0.0.1:51737` is behind the same login as everything else — a program on your machine needs a
  session or an access token, not just a connection (ADR-034 §1).
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
- **Anyone who can read your files, or run FinTrack as you.** The database key and the volume together decrypt everything;
  authentication guards the network surface, not the disk. The `auth` commands are trusted for exactly this reason: they
  open the database with its key, so whoever can run them already holds the data. On one OS account, a program that can run
  FinTrack can read the key and the database directly, so the login separates *people and network callers*, not your own
  account's processes. The stdio channel is likewise still trusted in this release (ADR-034 step 2 changes that). Back up
  the key and the volume together, and protect both.
- **Other local programs and local web apps, with auth explicitly `disabled` on loopback.** A web page from another *site* can
  no longer reach it (the `Host`/`Origin` rule above), but any program running as any user on your machine can still
  connect to `127.0.0.1` and act as the owner. That includes a web app served from `localhost` on a *different port*
  (a dev server, a local tool): its `Origin` is loopback, which is accepted on purpose so MCP Inspector
  (`http://localhost:6274`) works. FinTrack sends no CORS headers, so such a page cannot read responses, and a
  JSON write is stopped by the browser's preflight — but a simple, body-less cross-origin `POST` is not. That is
  today's behavior and the reason `disabled` is loopback-only; it is why `disabled` is
  an explicit opt-out and not the default.
- **Eavesdropping.** FinTrack serves plain HTTP. Across a network, put a TLS-terminating reverse proxy in front
  (and set `PUBLIC_URL`/`TRUST_PROXY`); Phase 3 documents and supports that deployment.
- **Username lockout.** Because failures are counted per submitted username, someone who can reach the login page can
  lock the owner's login out for 15 minutes by spamming wrong passwords (the cost of not revealing which usernames
  exist). The setup-code and session machinery are unaffected.
- **A restarted process forgetting rate-limit state.** The limiter is in memory.
- **More than one person.** There is one user; a second login cannot exist yet.
- **Eavesdropping on a token.** A bearer sent over plain HTTP across a network can be read; use TLS (Phase 3 documents the proxy deployment).

## What comes next

Phase 1 (identity) and Phase 2 (personal access tokens, scopes, Protected Resource Metadata) are done, and
[ADR-034](adr/034-local-auth-and-stdio-sign-in.md) step 1 (authentication on by default, the terminal owner claim and
password reset, no never-expiring tokens) with them.

| Step / phase | Adds |
|---|---|
| ADR-034 step 2 — stdio sign-in | A stdio session signs in through the browser with an expiry the user chooses (`/ui/connect`, `fintrack login`/`logout`, `/ui/access` listing); stdio stops acting as the owner. |
| 3 — MCP OAuth | An in-process OAuth 2.1 authorization server so OAuth-capable MCP clients can connect; the documented reverse-proxy + TLS deployment supersedes the loopback-only publish rule. |
| 4 — multi-user | `user_id` on every user-owned table (backfilled to the owner), per-user scoping, stdio identity from ADR-034's sign-in (there is no `FINTRACK_USER`), admin user management, and `fintrack key export` + the npm→Docker move guide. |
