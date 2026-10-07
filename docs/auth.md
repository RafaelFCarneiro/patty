# Authentication — operator guide

How FinTrack decides who may use its HTTP surface (`/api`, `/mcp`, `/ui`), how an instance gets its first login,
and what that does and doesn't protect. Decisions and rationale: [ADR-033](adr/033-authentication-and-multi-user.md).
Internals (hook, principal, tables): [`architecture.md`](architecture.md) § Authentication.

> **Status: Phase 1 of 4.** This release ships the identity foundation: exactly **one user** (the *owner*), password
> login, sessions, and the setup code. Personal access tokens (Phase 2), MCP OAuth (Phase 3) and multiple users with
> per-user data (Phase 4) come later — see [What comes next](#what-comes-next).

## Auth modes

`FINTRACK_AUTH` is `required` or `disabled`. Leave it unset and it follows `HOST`:

| `HOST` (bind address) | `FINTRACK_AUTH` unset | `FINTRACK_AUTH=required` | `FINTRACK_AUTH=disabled` |
|---|---|---|---|
| `127.0.0.1` (default), `127.x.x.x`, `::1`, `localhost` | **disabled** | required | disabled |
| `0.0.0.0`, `::`, a LAN IP, any other name | **required** | required | **startup error** |

- **`disabled`** — every request acts as the owner, with no login. This is the npm default (`HOST=127.0.0.1`): the
  server is reachable only from the machine it runs on, exactly as before authentication existed.
- **`required`** — every route except the [public surface](#the-public-surface) needs a session. This is the
  container's mode (`HOST=0.0.0.0`).
- **`disabled` on a non-loopback `HOST` is refused at startup.** The API is never unauthenticated on an interface other
  machines can reach.
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
**stderr** (stdout carries the MCP protocol, so it is never used):

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
- **A restart while still unclaimed prints a fresh code and invalidates the previous one** (there is only ever one code, replaced in place — even if two processes start together, only the last one stored works).** Lost the code? Restart.
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

## The public surface

Without a session, in `required` mode, exactly these answer:

| Route | Why |
|---|---|
| `GET /api/health` | Liveness plus `db: ok \| error` — nothing else. The container `HEALTHCHECK` uses it. |
| `GET`/`POST /ui/login`, `GET`/`POST /ui/setup` | They create the session. |
| `GET /ui/assets/app.css` | The one stylesheet those two pages use. |

Everything else — `/api/status`, the rest of `/api`, `/mcp`, `/ui`, `/ui/events`, the other UI assets, and any path
that doesn't exist — is `401` JSON (`/api`, `/mcp`, anything outside `/ui`) or a redirect (`/ui`: to `/ui/setup`
while the owner is unclaimed, otherwise to `/ui/login`). The list lives in one constant
(`PUBLIC_ROUTES`, `src/diplomat/http/authPaths.ts`), and a test enumerates every route Fastify registers to prove
nothing else is reachable.

## CSRF

A browser attaches the session cookie to any request to your instance, including ones a hostile page triggers. On top
of `SameSite=Lax`, every **unsafe** request (`POST`/`PUT`/`PATCH`/`DELETE` — including `POST /mcp`) that carries the
session cookie must declare, in `Origin` (or, failing that, `Referer`), an origin FinTrack recognises:

- `PUBLIC_URL`, when set; and
- the request's own origin **when it arrived at a loopback host** (`127.0.0.1:51737`, `localhost`) — so a local
  operator using a container's loopback port publish works without any setting.

Anything else is `403 forbidden_origin`. A non-loopback `Host` is never trusted as an origin on its own, so with no
`PUBLIC_URL` an instance reached at a LAN name refuses cookie-authenticated writes and says to set `PUBLIC_URL`.
`GET`/`HEAD` are unaffected. The pre-session `POST`s (`/ui/login`, `/ui/setup`) are checked too whenever a browser
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
checkpoints the WAL and copies the database file next to itself:

```
<DB_PATH>.pre-<migration>.bak        e.g.  ~/.fintrack/fintrack.db.pre-0018_auth_identity.bak
```

- It is the same encrypted file under the same key, mode `0600`, so it adds no exposure — and no value without the key.
- The path is logged to stderr (never the key). It is **not** made for a brand-new database, nor on later starts.
- To roll back: stop FinTrack, put the `.bak` back as `fintrack.db` (delete any `-wal`/`-shm` beside it), and run the
  previous release.
- Several FinTrack processes starting at once (multiple MCP clients) take turns on an OS-level lock
  (`<DB_PATH>.migrate.lock`, a tiny companion SQLite file), so exactly one takes the backup and migrates. The lock
  dies with its holder; the file itself is harmless and is left in place.
- Delete the backup once you've confirmed the upgrade. A refused backup (the database is busy under another process) stops
  startup rather than migrating without a safety copy.

## Threat model so far

**Protects against**

- Another machine on your network reading or writing your finances (required mode is forced off loopback).
- A hostile web page driving your logged-in browser (SameSite + Origin check; forms and JSON alike).
- Guessing credentials online (argon2id, rate limits, one generic error, constant-time unknown-user path).
- Someone claiming an exposed fresh instance before you (the setup code lives only in your logs).
- A leaked database file or backup yielding passwords or sessions (only hashes are stored; the database is encrypted).
- Credentials in logs (cookies, `Set-Cookie` and `Authorization` are redacted; passwords, tokens and codes are never
  logged — the one deliberate exception is the setup code's single log line).

**Does not protect against**

- **Anyone who can read your files.** The database key and the volume together decrypt everything; authentication
  guards the network surface, not the disk. Back up the key and the volume together, and protect both.
- **Auth `disabled` on loopback.** Any local process — and, via DNS rebinding, a web page you visit — can reach
  `127.0.0.1`. That is today's behavior and the reason `disabled` is loopback-only; turn on `FINTRACK_AUTH=required`
  if that matters to you.
- **Eavesdropping.** FinTrack serves plain HTTP. Across a network, put a TLS-terminating reverse proxy in front
  (and set `PUBLIC_URL`/`TRUST_PROXY`); Phase 3 documents and supports that deployment.
- **Username lockout.** Because failures are counted per submitted username, someone who can reach the login page can
  lock the owner's login out for 15 minutes by spamming wrong passwords (the cost of not revealing which usernames
  exist). The setup-code and session machinery are unaffected.
- **A restarted process forgetting rate-limit state.** The limiter is in memory.
- **More than one person.** There is one user; a second login cannot exist yet.

## What comes next

| Phase | Adds |
|---|---|
| 2 — personal access tokens | `ftk_…` bearer tokens with read/write scopes for `/api` and `/mcp`; token management UI; `WWW-Authenticate` challenges; Protected Resource Metadata. |
| 3 — MCP OAuth | An in-process OAuth 2.1 authorization server so OAuth-capable MCP clients can connect; the documented reverse-proxy + TLS deployment supersedes the loopback-only publish rule. |
| 4 — multi-user | `user_id` on every user-owned table (backfilled to the owner), per-user scoping, `FINTRACK_USER` for stdio, admin user management, and `fintrack key export` + the npm→Docker move guide. |

### Temporary limitation: MCP over HTTP in the container

With authentication `required` (always, in the container), `/mcp` accepts only a **session cookie** until Phase 2 adds
bearer tokens. MCP clients don't carry one, so **an MCP client cannot yet connect to the container's `/mcp`.** The
dashboards and REST API work in a browser session, and **stdio (npm) is unaffected** — use it for MCP in the
meantime. [`mcp-clients.md`](mcp-clients.md#docker-container-http-on-12700151737) carries the same note.
