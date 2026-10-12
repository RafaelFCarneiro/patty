# Authentication flows (ADR-033 Phases 1–2, ADR-034 steps 1–2)

These diagrams show the flows as built: who takes part in each one and what happens at each step.
The operator guide is [`auth.md`](auth.md); the decision record is
[`adr/033-authentication-and-multi-user.md`](adr/033-authentication-and-multi-user.md) and
[`adr/034-local-auth-and-stdio-sign-in.md`](adr/034-local-auth-and-stdio-sign-in.md).

**Participants** (each name matches a source file):

| Participant | Where | Role |
|---|---|---|
| Config | `src/config.ts` | Reads `FINTRACK_AUTH` (default `required`) and refuses `disabled` on an exposed instance (`HOST` / `PUBLIC_URL` / `TRUST_PROXY`) |
| VersionGuard | `src/diplomat/db/versionGuard.ts` (rule: `src/logic/migration.ts`) | First thing `bootstrap` does: refuses a database a newer build has migrated, before anything is copied, migrated, seeded or written |
| Bootstrap | `src/diplomat/db/bootstrap.ts`, `safetyCopy.ts`, `migrationLock.ts` | Migrations, the owner row, the pre-migration backup |
| AuthRuntime | `src/authRuntime.ts` | Builds the identity deps (shared with the CLI and the stdio session), prunes sessions and expired sign-in requests, issues and prints the setup code |
| Cli | `src/cli.ts`, `src/authCli.ts`, `src/loginCli.ts`, `src/diplomat/cli/{prompt,terminal}.ts` | `fintrack setup [client]`, `auth setup`, `auth reset-password`, `login`, `logout`: opens the database like the server (no stdio), prompts with no echo, runs the controller flows; an unknown command prints the usage and exits non-zero |
| SignInServer | `src/signInServer.ts` | Where `login` sends the browser: a FinTrack already answering `/api/health` on `HOST:PORT`, else a temporary loopback app for the length of the login |
| StdioSession | `src/diplomat/mcp/stdioSession.ts`, `gate.ts`, `scopes.ts` | The stdio channel's identity: resolves the credential per call (`FINTRACK_TOKEN` → keychain → none), asks for a sign-in, polls, saves; the scope guard asks it who is calling |
| SignInStore | `src/diplomat/auth/signInStore.ts` | The OS keychain entry `signin:<profile>:<dbId>` of a saved sign-in |
| AuthHook | `src/diplomat/http/hooks/auth.ts` — `registerAuthHook` (decisions in `src/logic/auth.ts`) | The `onRequest` hook: the loopback Host/Origin guard (auth disabled), the public allowlist, credential precedence (bearer vs. cookie), session/token resolution, the CSRF check, the route-scope check, challenges and redirects |
| Bearer | `src/diplomat/http/bearer.ts` | Builds the `WWW-Authenticate` response (`logic/auth.ts`'s `bearerChallenge`; only the origin is resolved at the edge) — shared by the hook and the MCP route |
| AuthRoutes | `src/diplomat/http/routes/auth.ts` | `/ui/setup`, `/ui/login`, `/ui/logout`: form parsing, rate limiting, cookies |
| TokenRoutes | `src/diplomat/http/routes/tokens.ts` | `/ui/access/tokens`, `/ui/access/tokens/:id/revoke`: session-only token pages (personal access tokens and stdio sign-ins) |
| ConnectRoutes | `src/diplomat/http/routes/connect.ts` | `/ui/connect`: the session-only consent page for a stdio / `login` sign-in; throttles failed code lookups |
| WellKnown | `src/diplomat/http/routes/wellKnown.ts` | The two Protected Resource Metadata (RFC 9728) routes |
| McpRoute | `src/diplomat/mcp/route.ts`, `scopes.ts` | `POST /mcp`: per-tool scope pre-check on the JSON-RPC body, `req.auth` for the transport, per-tool re-check |
| Controller | `src/controllers/auth.ts`, `accessTokens.ts`, `grants.ts` | `issueSetupCode`, `claimOwner`, `claimOwnerLocally`, `resetPassword`, `login`, `logout`, `authenticate`; `createToken`, `listTokens`, `revokeToken`, `revokeSignInByHash`, `authenticateToken`; `startGrant`, `findConsent`, `approveGrant`, `denyGrant`, `redeemGrant`, `pruneExpiredGrants`; returns `{ persist, response }` |
| Logic | `src/logic/auth.ts` | Pure rules: expiry, the sliding window, "can log in", origin comparison, scopes, the token verdict, credential parsing, challenges, the metadata document; the grant transitions, `signInExpiry`, the consent pre-selection, `redeemPlan`, the not-signed-in message |
| Secrets | `src/diplomat/auth/credentials.ts` | argon2id, CSPRNG session tokens, access tokens (`ftk_…`), setup / user / device codes, sha256 |
| Runner | `@rfc0/effect-runner` via `runEffects` | Applies the persistables in one transaction (optimistic versions, retries) |
| DB | `users`, `sessions`, `setup_codes`, `access_tokens`, `client_grants` | Stores only hashes, never a token or code in plaintext |

---

## 1. Startup: which mode, the owner row, and the setup code

```mermaid
flowchart TD
    A[Process starts] --> B[Config: parse env]
    B --> C{FINTRACK_AUTH set?}
    C -- yes --> D[Use it]
    C -- no --> F[required<br/>the default on EVERY surface,<br/>loopback included]
    D --> H{disabled AND exposed?<br/>non-loopback HOST<br/>or PUBLIC_URL<br/>or TRUST_PROXY}
    H -- yes --> X[[Startup error:<br/>no unauthenticated exposure]]
    H -- no --> I
    F --> I
    I[Open DB with key<br/>file → env → keychain] --> VG{"Version guard: the DB's newest applied<br/>migration newer than this build's journal?"}
    VG -- yes --> XV[["Exit 1: this build is older than your database<br/>update with npx … @latest · npm ls -g<br/>nothing copied, migrated, seeded or written"]]
    VG -- "no (equal, behind, or a fresh DB)" --> J{Data-rewriting migration pending<br/>on an existing DB?}
    J -- yes --> K[Take the OS-level migration lock<br/>VACUUM INTO db.pre-0018_auth_identity.bak<br/>under SQLite's write lock<br/>encrypted, 0600<br/>migrations applied in the same transaction]
    J -- no --> L
    K --> L[Migrations applied<br/>0018 inserts the OWNER row:<br/>id user-owner, admin, no credentials]
    L --> M{Mode required?}
    M -- "no: an explicit disabled, loopback-only" --> N[Every HTTP request AND the stdio channel<br/>act as the owner]
    M -- yes --> O[Load argon2, build the identity deps<br/>prune expired sessions and unanswered sign-in requests]
    O --> OS{Transport stdio?}
    OS -- yes --> OT[The stdio session is created:<br/>it acts as nobody until it holds a credential — diagram 9]
    OS -- no --> OH
    OT --> OH{HTTP surface on?}
    OH -- "no: FINTRACK_HTTP=false" --> RS[Ready: stdio only<br/>sign in with FINTRACK_TOKEN or login]
    OH -- yes --> P[Bind HTTP]
    P --> Q{Bound successfully?}
    Q -- no --> R[No setup code issued<br/>the process that owns the port keeps its own]
    Q -- yes --> S{Owner unclaimed?}
    S -- no --> T[Ready: login required]
    S -- yes --> U[Generate a 100-bit code<br/>store only its sha256 in the single setup_codes row<br/>expires in 30 min, replaces any older code]
    U --> V[Print the banner to STDERR once<br/>docker compose logs · a stdio client's log file<br/>names /ui/setup AND npx … auth setup]
```

## 2. First-time setup: claiming the owner

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (browser)
    participant Hook as AuthHook
    participant Routes as AuthRoutes
    participant Ctl as Controller.claimOwner
    participant Sec as Secrets
    participant Run as Runner
    participant DB

    Op->>Hook: GET /ui
    Hook->>Hook: not a public route, no session cookie
    Hook->>DB: owner unclaimed?
    DB-->>Hook: yes
    Hook-->>Op: 303 → /ui/setup
    Op->>Hook: GET /ui/setup (public)
    Hook->>Routes: pass
    Routes-->>Op: setup form (CSP locked, no-store)
    Op->>Hook: POST /ui/setup {code, username, password}
    Hook->>Hook: public route — if the browser declared an Origin, it must be ours (forced-login defence)
    Hook->>Routes: pass
    Routes->>Routes: zod: normalize the username (NFKC, lowercase), password ≥ 12
    Routes->>Routes: rate limiter: reserve a strike (per IP and per username)
    Routes->>Run: runEffects(claimOwner)
    Run->>Ctl: run the flow
    Ctl->>DB: read the owner — still unclaimed? (else setup_unavailable, 409)
    Ctl->>Sec: sha256(normalized code)
    Ctl->>DB: find the setup code by hash
    Ctl->>Ctl: usable? not used, not expired (else invalid_setup_code, 403)
    Ctl->>Sec: argon2id(password)
    Ctl->>Sec: random 256-bit session token, then sha256(token)
    Ctl-->>Run: persist: UPDATE owner (username, hash), UPDATE code (usedAt), INSERT session (hash)
    Run->>DB: one transaction, versioned (a concurrent claim conflicts, retries, then gets setup_unavailable)
    Run-->>Routes: the plaintext token (in memory only)
    Routes->>Routes: clear the IP strike, reset the username
    Routes-->>Op: 303 → /ui + Set-Cookie fintrack_session (HttpOnly, SameSite=Lax, Secure on https)
```

## 2b. First setup from the terminal

`fintrack setup <client>` and `fintrack auth setup` (ADR-034 §5). The CLI is a process of its own: it opens the database
with the same key resolution and migrations as the server, but starts neither HTTP nor stdio. Nothing here is typed into a
chat, and no sign-in link or setup code is involved.

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (terminal)
    participant Cli as Cli (setup / auth setup)
    participant DB as Database (key from keychain / file / env)
    participant Ctl as Controller.claimOwnerLocally
    participant Run as Runner
    participant Cfg as Client config file

    Op->>Cli: npx @rafaelfcarneiro/fintrack@latest setup claude-code
    Cli->>Cli: unknown client or no client? help or error, nothing else happens
    Cli->>DB: open + bootstrap (migrations, so the owner row exists)
    Cli->>DB: owner already claimed?
    alt claimed
        Cli-->>Op: one line: who owns it. Skip the claim (exit 0 for auth setup)
    else unclaimed
        alt stdin is a terminal
            Cli->>Op: Username, then Password twice (no echo, 3 tries each, same rules as /ui/setup)
        else --username + --password-stdin
            Op->>Cli: password piped on stdin
        else no terminal and no --password-stdin
            Cli-->>Op: instructions on stderr, exit 1 — before the claim and the config write
        end
        Cli->>Ctl: runEffects(claimOwnerLocally)
        Ctl->>DB: read the owner — still unclaimed? (else setup_unavailable = already claimed)
        Ctl->>Ctl: argon2id(password)
        Ctl-->>Run: persist: UPDATE owner (username, hash) + UPDATE the outstanding setup code as used
        Run->>DB: one transaction, versioned. No user INSERT, no session
        Cli-->>Op: Owner claimed (never the password)
    end
    opt setup <client> only
        Cli->>Cfg: merge the fintrack entry (idempotent, other keys kept, FINTRACK_PROFILE in env only for a non-default --profile)
        Cli-->>Op: restart your client
        Cli->>Op: Sign in this client now? [Y/n]  (no terminal: a one-line hint, skipped)
        Note over Cli,Op: yes runs the login flow of diagram 10 for the client's profile — a failure never fails the setup
    end
```

### Reset a password

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (terminal)
    participant Cli as Cli (auth reset-password)
    participant Ctl as Controller.resetPassword
    participant Run as Runner
    participant DB

    Op->>Cli: auth reset-password [--user ana]
    Cli->>DB: find the target (default: the owner, who must have a login)
    alt unknown user, or unclaimed owner
        Cli-->>Op: clear error on stderr, exit 1 — no password asked
    else found
        Op->>Cli: new password (twice, no echo) or --password-stdin
        Cli->>Ctl: runEffects(resetPassword)
        Ctl->>DB: that user's sessions and live access tokens
        Ctl-->>Run: persist: UPDATE user (hash) + DELETE each session + UPDATE each live token (revoked_at)
        Run->>DB: one transaction, versioned
        Cli-->>Op: sessions ended: N · tokens revoked: M
    end
    Note over DB: other users' rows are never read into the batch
```

## 3. Login

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant Hook as AuthHook
    participant Routes as AuthRoutes
    participant Ctl as Controller.login
    participant Sec as Secrets
    participant DB

    U->>Hook: GET /ui/overview (no cookie)
    Hook-->>U: 303 → /ui/login?next=/ui/overview  (next is validated: same-origin, under /ui only)
    U->>Routes: GET /ui/login (public) → form
    U->>Hook: POST /ui/login {username, password, next}
    Hook->>Hook: public route + Origin check if declared
    Hook->>Routes: pass
    Routes->>Routes: limited? (IP: 20 per 15 min · username: 5 per 15 min) → 429 page
    Routes->>Routes: reserve a strike
    Routes->>Ctl: runEffects(login)
    Ctl->>DB: user by normalized username
    Ctl->>Sec: argon2 verify against the real hash, or a DUMMY hash if the user is unknown or unclaimed (same cost)
    Ctl->>Ctl: canLogin = found AND matches AND claimed AND not disabled
    alt any failure
        Ctl-->>Routes: invalid_credentials (one generic message)
        Routes-->>U: 401 login page "Invalid username or password." (strike kept)
    else success
        Ctl-->>Routes: persist: delete expired sessions + INSERT new session (hash)
        Routes-->>U: 303 → next + Set-Cookie fintrack_session
    end
```

## 4. Every authenticated request (the auth hook)

```mermaid
flowchart TD
    A[Request arrives] --> B{Mode?}
    B -- disabled --> L{"Host loopback?<br/>AND (no Origin<br/>OR loopback Origin)"}
    L -- no --> FL["403 forbidden_origin<br/>DNS-rebound or cross-site page<br/>hint: set PUBLIC_URL"]
    L -- yes --> C["principal = OWNER (every scope)<br/>the Authorization header is ignored"] --> Z[Handler]
    B -- required --> D{Matched route is in<br/>the PUBLIC_ROUTES allowlist?<br/>/api/health · /ui/login · /ui/setup · app.css<br/>· the two /.well-known/oauth-protected-resource routes}
    D -- yes --> E{Unsafe method AND<br/>Origin/Referer declared?}
    E -- "yes, not ours" --> F[403 forbidden_origin]
    E -- otherwise --> Z
    D -- no, incl. unknown paths --> BP{"Path is /api or /mcp<br/>AND an Authorization<br/>header is present?"}
    BP -- "yes" --> BT["Bearer branch — diagram 4b:<br/>the header is authoritative,<br/>the cookie is never consulted"]
    BP -- no --> G[Read the fintrack_session cookie]
    G --> H{Cookie present?}
    H -- no --> N
    H -- yes --> I[sha256 token → session row → user]
    I --> J{Valid?<br/>not idle-expired: 7 d sliding<br/>under the 30 d absolute cap<br/>user claimed, not disabled}
    J -- no --> K[Delete the session row] --> N
    J -- yes --> L2{Last seen ≥ 5 min ago?}
    L2 -- yes --> M[Slide expiry: UPDATE session] --> O
    L2 -- no --> O
    O{Unsafe method?<br/>POST/PUT/PATCH/DELETE}
    O -- yes --> P{Origin equals PUBLIC_URL,<br/>or this loopback host's own origin?}
    P -- no --> F
    P -- yes --> Q
    O -- no --> Q["principal = user, every scope<br/>(a session holds read + write)"] --> Z
    N{Path under /ui?}
    N -- "no: /api, /mcp, other" --> R["401 JSON unauthenticated<br/>+ WWW-Authenticate: Bearer resource_metadata, scope"]
    N -- yes --> S{Owner unclaimed?}
    S -- yes --> T[303 → /ui/setup]
    S -- no --> U[303 → /ui/login?next=…]
```

## 4b. Bearer token request (REST / MCP)

Precedence → verify → scope → handler / 401 / 403. A bearer carries no ambient credential, so there is **no CSRF check**.
`/ui` never takes this path: a bearer there is "no credential" and gets the login redirect.

```mermaid
flowchart TD
    A["/api or /mcp request<br/>with an Authorization header"] --> B{"Header is exactly<br/>Bearer ftk_… ?"}
    B -- "no: another scheme, empty,<br/>not our prefix" --> X1["401 invalid_token<br/>WWW-Authenticate: Bearer error=invalid_token, resource_metadata<br/>the cookie is NOT tried"]
    B -- yes --> C[sha256 token → access_tokens row → user]
    C --> D{"Row exists, not revoked,<br/>not expired,<br/>owner claimed and enabled,<br/>kind admitted here (a personal access<br/>token; a stdio sign-in is stdio-only)?"}
    D -- no --> X1
    D -- yes --> E{"last_used_at older<br/>than 5 min?"}
    E -- yes --> F[UPDATE last_used_at — version-guarded] --> G
    E -- no --> G["principal = user with the TOKEN's scopes<br/>via = token, tokenId"]
    G --> H{"Scope needed by the matched route<br/>(RouteDefinition.scope; POST /mcp: read)<br/>covered? write implies read"}
    H -- no --> X2["403 insufficient_scope<br/>WWW-Authenticate: Bearer error=insufficient_scope, scope=fintrack:write, resource_metadata"]
    H -- yes --> I{"POST /mcp?"}
    I -- no --> Z[REST handler]
    I -- yes --> J["preHandler: read the JSON-RPC body<br/>(each message of a batch)<br/>tools/call of a write tool?<br/>unknown tool counts as write"]
    J -- "needs write, token has read only" --> X2
    J -- ok --> K["req.raw.auth = AuthInfo<br/>(token id, clientId pat:id, scopes)"]
    K --> L["scope guard asks the HTTP PrincipalGate (authInfoGate):<br/>extra.authInfo.scopes against the tool's readOnlyHint scope,<br/>or read for a resource / prompt (no authInfo = refused)"]
    L -- short --> X3["tool error insufficient_scope — the tool never runs"]
    L -- ok --> M[Tool runs]
```

## 4c. Create / revoke a token

```mermaid
sequenceDiagram
    autonumber
    actor U as Person (browser, signed in)
    participant Hook as AuthHook
    participant Routes as TokenRoutes
    participant Ctl as Controller (accessTokens)
    participant Sec as Secrets
    participant Run as Runner
    participant DB

    U->>Hook: POST /ui/access/tokens {name, access, expiry, password} (cookie + same Origin)
    Hook->>Hook: /ui → session only (a bearer here is ignored), then the CSRF Origin check
    Hook->>Routes: pass, principal.via = session
    Routes->>Routes: preHandler insists on via = session, zod validates: name 1–80, access read|write, expiry none|30|90|365, password present. Rate limit per IP and user
    Routes->>Run: runEffects(createToken)
    Run->>Ctl: run the flow
    Ctl->>Sec: verify the password against the user's hash (step-up, same cost if it fails). Wrong: 403 page, nothing created
    Ctl->>Sec: randomAccessToken() = ftk_ + 32 random bytes (base64url)
    Ctl->>Sec: sha256(token), display prefix = ftk_ + first 6 chars
    Ctl-->>Run: persist: INSERT access_token {hash, prefix, scopes, expires_at} and the response is the plaintext + summary
    Run->>DB: one transaction
    Run-->>Routes: plaintext (in memory only)
    Routes-->>U: 200 page showing the token ONCE (no-store, CSP) — "you won't see it again"
    Note over DB: only the hash and the prefix are stored, and request logs redact Authorization

    U->>Hook: POST /ui/access/tokens/:id/revoke (cookie + same Origin)
    Hook->>Routes: pass
    Routes->>Run: runEffects(revokeToken)
    Run->>Ctl: find the token among this user's
    alt unknown id
        Ctl-->>Routes: unknown_token → 404 page
    else already revoked
        Ctl-->>Run: persist: nothing (idempotent)
    else active
        Ctl-->>Run: persist: UPDATE revoked_at (row kept)
    end
    Routes-->>U: 303 → /ui/access/tokens
    Note over U,DB: the very next request with that token is 401 invalid_token
```

## 5. Logout and live dashboards (SSE)

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant Hook as AuthHook
    participant Routes as AuthRoutes
    participant SSE as /ui/events stream
    participant DB

    U->>Hook: GET /ui/events (cookie)
    Hook->>Hook: session valid → principal
    Hook->>SSE: open the stream
    loop every 30 s
        SSE->>DB: re-resolve the session (fails closed on error)
        alt session gone, expired or user disabled
            SSE-->>U: end the stream
        end
    end
    Note over SSE: auth writes (user / session / setup_code / access_token / client_grant) are filtered out of change events

    U->>Hook: POST /ui/logout (cookie + same Origin)
    Hook->>Routes: authenticated + CSRF ok
    Routes->>DB: runEffects(logout) — DELETE the session row
    alt delete committed
        Routes-->>U: 303 → /ui/login + Set-Cookie clearing fintrack_session (Max-Age=0)
    else delete failed
        Routes-->>U: error, cookie NOT cleared (never fake a logout)
    end
```

## 6. Who acts as whom, per transport

```mermaid
flowchart LR
    subgraph L1["Local npm: loopback, auth required by default"]
      S1[MCP client] -- "stdio — signs in first (diagram 8):<br/>FINTRACK_TOKEN, a saved sign-in, or a browser approval" --> O1((Owner, with the scopes<br/>the approval granted))
      B1[Browser /ui] -- "needs a login<br/>session cookie + Origin check" --> O1
      C1["Script / client over HTTP<br/>Authorization: Bearer ftk_…"] -- "access token, no CSRF check" --> O1
      P1[Any other local program] -. "no credential: 401 / redirect to login" .-> X1[rejected]
    end
    subgraph L1D["Local, explicit FINTRACK_AUTH=disabled (development, tests)"]
      B1D[Browser /ui, /api] -- "loopback Host/Origin only<br/>Authorization ignored" --> O1D((Owner, all scopes))
      S1D[MCP client over stdio] -- "no sign-in" --> O1D
    end
    subgraph L2["Docker or exposed: auth required"]
      B2[Browser] -- session cookie + Origin check --> O2((Owner))
      M2["MCP client over HTTP<br/>Authorization: Bearer ftk_…"] -- "access token, no CSRF check<br/>scopes: read or read+write" --> O2
      M2 -. "no credential: 401 + resource_metadata" .-> X2[rejected]
      H2[Healthcheck] -- /api/health only --> P2[public]
      W2[Any client] -- "/.well-known/oauth-protected-resource[/mcp]" --> P2
    end
```

## 7. Your existing database through this phase

```mermaid
sequenceDiagram
    autonumber
    participant You as You (stdio, npm)
    participant FT as FinTrack (new version)
    participant DB as ~/.fintrack/fintrack.db
    participant Cli as setup / auth setup

    You->>FT: first start after upgrading
    FT->>DB: migration 0018 pending on an existing DB?
    FT->>DB: VACUUM INTO fintrack.db.pre-0018_auth_identity.bak under SQLite's write lock (encrypted, same key)
    FT->>DB: migrations applied in the same transaction: create users / sessions / setup_codes + INSERT the owner (no credentials)
    Note over DB: no domain table touched — accounts, transactions … unchanged
    FT-->>You: auth is required by default, so /ui asks for a login, and the sidecar prints a setup code and the `auth setup` hint to stderr. The first stdio tool call answers "not signed in" (with the setup hint while the owner is unclaimed)
    You->>Cli: npx @rafaelfcarneiro/fintrack@latest setup <client>  (or auth setup) — once
    Cli->>DB: UPDATE the existing owner row with your username and password hash (never an INSERT of a user)
    Note over You,DB: log in at /ui — it is the same database, so the same data. Nothing was copied or migrated. Then approve the client's sign-in link once (diagram 8)
```

## 8. stdio sign-in (device flow)

ADR-034 §3. Three parties and one database: the stdio **process** (spawned by the client), the person's **browser**, and
FinTrack's HTTP surface (this process's sidecar, or another FinTrack process's on the same port — the grant is a database row, so
either works). Nothing secret travels in a URL or a tool result: the link carries the **user code** only, and the **device
code** that redeems it never leaves the asking process.

```mermaid
sequenceDiagram
    autonumber
    actor P as Person (browser)
    participant C as MCP client
    participant S as StdioSession
    participant G as Controller (grants)
    participant R as ConnectRoutes
    participant DB

    C->>S: tools/call (any tool) — or resources/read, prompts/get
    S->>S: no credential (diagram 9) → ask
    S->>G: runEffects(startGrant {client name + version from initialize, profile, channel stdio})
    G->>G: device code = 256 random bits (returned once) · user code = 8 Crockford symbols, free among pending grants
    G->>DB: INSERT client_grant {sha256(device code), user code, status pending, expires in 10 min}
    G-->>S: device code (kept in memory) + ABCD-EFGH
    S-->>C: isError result: "FinTrack: not signed in. Open ORIGIN/ui/connect?code=ABCD-EFGH and confirm the code ABCD-EFGH."
    Note over C,S: the next calls reuse the SAME pending request until it is answered or expires

    P->>R: GET /ui/connect?code=ABCD-EFGH
    R->>R: no session? → 303 /ui/login?next=…the same link… and back after login
    R->>R: failed lookups per IP are throttled (429)
    R->>G: findConsent(user, code)
    G-->>R: pending and unexpired only — client (as reported), profile, time, pre-selection: asker's hint, else your last choice, else read-only / 24 h
    alt unknown, expired or already answered
        R-->>P: the same neutral page for all three
    else
        R-->>P: consent page (CSP, no-store): client name, code, warning, access, duration, Approve / Deny
    end
    P->>R: POST /ui/connect {code, decision, access, duration} (cookie + same Origin)
    R->>G: runEffects(approveGrant | denyGrant) — session principal only
    G->>DB: UPDATE grant → approved (approver = this session's user, scopes, duration, approved_at) | denied

    loop every 2 s, and on each gated call
        S->>G: runEffects(redeemGrant {device code})
        alt still pending
            G-->>S: pending
        else approved
            G->>DB: INSERT access_token {kind stdio, client, profile, scopes, expires_at = approved_at + duration, hash} + UPDATE grant → redeemed — ONE batch
            G-->>S: signed_in + the token (plaintext, once)
            opt duration is not "this session only"
                S->>S: save the token to the keychain (signin:profile:dbId)
            end
            S-->>C: the waiting call proceeds
        else denied / expired / already redeemed
            G-->>S: terminal — the pending request is dropped and the next gated call starts a fresh one
        end
    end
```

## 9. stdio credential resolution, expiry and re-sign-in

Every gated request (tool call, resource read, prompt get) runs this. `initialize` and the list requests never do. The
credential is re-validated through the same `authenticateToken` the HTTP edge uses, so revocation and expiry take effect on
the **next call**; a failed lookup is "could not check", never a sign-out.

```mermaid
flowchart TD
    A[Gated stdio request] --> B{Auth disabled?}
    B -- "yes (explicit)" --> Z["Owner, all scopes — no session exists"]
    B -- no --> C{FINTRACK_TOKEN set?}
    C -- yes --> D{"Shaped like ftk_… and valid?<br/>not revoked, not expired,<br/>owner enabled"}
    D -- yes --> G["principal: the token's scopes, via stdio"]
    D -- no --> E["Error: FINTRACK_TOKEN is not a valid access token<br/>NEVER a fallback to the keychain, never echoed"]
    C -- no --> H{"Credential held in memory<br/>(this process's sign-in)?"}
    H -- yes --> I{Still valid?}
    I -- yes --> G
    I -- "no: revoked / expired / user disabled" --> J["Forget it. A saved one is deleted from the keychain<br/>only if the keychain still holds THIS credential;<br/>a 'this session only' one never touched it"]
    H -- no --> K{"Saved sign-in in the keychain for<br/>this profile and database?"}
    J --> K
    K -- yes --> L{Still valid?}
    L -- yes --> G
    L -- no --> M[Delete the keychain entry]
    K -- no --> N
    M --> N{"HTTP dashboard available?<br/>(FINTRACK_HTTP not false)"}
    N -- no --> O["Not signed in: use fintrack login<br/>or set FINTRACK_TOKEN (no link)"]
    N -- yes --> Q{"A pending request of ours<br/>still open?"}
    Q -- yes --> R[Poll it once: redeem]
    Q -- no --> T[startGrant — diagram 8]
    R -- approved --> U[Adopt the token — save to the keychain unless 'this session only'] --> G
    R -- still pending --> V["Not signed in: the same link and code"]
    R -- "denied / expired" --> T
    T --> V
    G --> W{"Scope covers the request?<br/>read for resources, prompts and read-only tools"}
    W -- yes --> Y[Runs]
    W -- no --> X["tool error insufficient_scope<br/>(a resource / prompt: a JSON-RPC error)"]
    Y --> AA["On shutdown: a 'this session only' sign-in is revoked (best effort;<br/>the 12-hour cap covers a crash)"]
```

## 10. `fintrack login` and `logout`

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (terminal + browser)
    participant Cli as Cli (login / logout)
    participant SS as SignInServer
    participant G as Controller (grants)
    participant K as SignInStore (keychain)
    participant DB

    Op->>Cli: login [--profile p] [--duration d] [--scope s]
    Cli->>DB: open + bootstrap (the version guard runs first)
    Cli->>Cli: auth disabled? owner unclaimed? → say so, exit 1
    Cli->>SS: where is /ui/connect?
    alt a FinTrack answers /api/health on HOST:PORT
        SS-->>Cli: that origin
    else none
        SS->>SS: start a temporary loopback app (authentication required) — closed when the login ends
        SS-->>Cli: its origin
    end
    Cli->>G: startGrant {fintrack login, version, profile, channel cli, hint scope + duration}
    Cli-->>Op: Open ORIGIN/ui/connect?code=ABCD-EFGH and confirm the code ABCD-EFGH. Waiting… (Ctrl-C cancels)
    Note over Op,DB: the person approves in the browser as in diagram 8 — "this session only" is not offered to a cli request
    loop every 2 s
        Cli->>G: redeemGrant
    end
    G-->>Cli: signed_in + token
    Cli->>K: save signin:profile:dbId
    alt the keychain refuses
        Cli->>G: revoke the sign-in again, exit 1
    else saved
        Cli-->>Op: Signed in on profile "p" (read|write) until DATE — never the token
    end
    Note over Cli: denied / expired → exit 1 · Ctrl-C → "Cancelled." and exit 130 · the temporary server and the database are closed either way

    Op->>Cli: logout [--profile p]
    Cli->>K: load the profile's saved sign-in
    alt nothing saved
        Cli-->>Op: Not signed in on profile "p" (exit 0)
    else saved
        Cli->>G: revokeSignInByHash — revoked_at on a stdio sign-in, a no-op for anything else
        Cli->>K: delete the entry
        Cli-->>Op: Signed out of profile "p"
    end
```
