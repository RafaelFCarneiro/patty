# Authentication flows (ADR-033 Phase 1)

These diagrams show the flows as built: who takes part in each one and what happens at each step.
The operator guide is [`auth.md`](auth.md); the decision record is
[`adr/033-authentication-and-multi-user.md`](adr/033-authentication-and-multi-user.md).

**Participants** (each name matches a source file):

| Participant | Where | Role |
|---|---|---|
| Config | `src/config.ts` | Decides the auth mode from `HOST` / `PUBLIC_URL` / `TRUST_PROXY` / `FINTRACK_AUTH` |
| Bootstrap | `src/diplomat/db/bootstrap.ts`, `safetyCopy.ts`, `migrationLock.ts` | Migrations, the owner row, the pre-migration backup |
| AuthRuntime | `src/authRuntime.ts` | Builds the identity deps, prunes sessions, issues and prints the setup code |
| AuthGate | `src/diplomat/http/hooks/auth.ts` (decisions in `src/logic/auth.ts`) | The `onRequest` hook: the loopback Host/Origin guard (auth disabled), the public allowlist, session resolution, the CSRF check, redirects |
| AuthRoutes | `src/diplomat/http/routes/auth.ts` | `/ui/setup`, `/ui/login`, `/ui/logout`: form parsing, rate limiting, cookies |
| Controller | `src/controllers/auth.ts` | `issueSetupCode`, `claimOwner`, `login`, `logout`, `authenticate`; returns `{ persist, response }` |
| Logic | `src/logic/auth.ts` | Pure rules: expiry, the sliding window, "can log in", origin comparison |
| Secrets | `src/diplomat/auth/credentials.ts` | argon2id, CSPRNG tokens and codes, sha256 |
| Runner | `@rfc0/effect-runner` via `runEffects` | Applies the persistables in one transaction (optimistic versions, retries) |
| DB | `users`, `sessions`, `setup_codes` | Stores only hashes, never a token or code in plaintext |

---

## 1. Startup: which mode, the owner row, and the setup code

```mermaid
flowchart TD
    A[Process starts] --> B[Config: parse env]
    B --> C{FINTRACK_AUTH set?}
    C -- yes --> D[Use it]
    C -- no --> E{Exposed?<br/>non-loopback HOST<br/>or PUBLIC_URL<br/>or TRUST_PROXY}
    E -- yes --> F[required]
    E -- no --> G[disabled]
    D --> H{disabled AND exposed?}
    H -- yes --> X[[Startup error:<br/>no unauthenticated exposure]]
    H -- no --> I
    F --> I
    G --> I
    I[Open DB with key<br/>file → env → keychain] --> J{Data-rewriting migration pending<br/>on an existing DB?}
    J -- yes --> K[Take the OS-level migration lock<br/>VACUUM INTO db.pre-0018_auth_identity.bak<br/>encrypted, 0600]
    J -- no --> L
    K --> L[Apply migrations<br/>0018 inserts the OWNER row:<br/>id user-owner, admin, no credentials]
    L --> M{Mode required<br/>AND an HTTP surface?}
    M -- no --> N[Every HTTP request acts as the owner<br/>stdio acts as the owner]
    M -- yes --> O[Load argon2, build the identity deps<br/>prune expired sessions]
    O --> P[Bind HTTP]
    P --> Q{Bound successfully?}
    Q -- no --> R[No setup code issued<br/>the process that owns the port keeps its own]
    Q -- yes --> S{Owner unclaimed?}
    S -- no --> T[Ready: login required]
    S -- yes --> U[Generate a 100-bit code<br/>store only its sha256 in the single setup_codes row<br/>expires in 30 min, replaces any older code]
    U --> V[Print the banner to STDERR once<br/>docker compose logs]
```

## 2. First-time setup: claiming the owner

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (browser)
    participant Gate as AuthGate
    participant Routes as AuthRoutes
    participant Ctl as Controller.claimOwner
    participant Sec as Secrets
    participant Run as Runner
    participant DB

    Op->>Gate: GET /ui
    Gate->>Gate: not a public route, no session cookie
    Gate->>DB: owner unclaimed?
    DB-->>Gate: yes
    Gate-->>Op: 303 → /ui/setup
    Op->>Gate: GET /ui/setup (public)
    Gate->>Routes: pass
    Routes-->>Op: setup form (CSP locked, no-store)
    Op->>Gate: POST /ui/setup {code, username, password}
    Gate->>Gate: public route — if the browser declared an Origin, it must be ours (forced-login defence)
    Gate->>Routes: pass
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

## 3. Login

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant Gate as AuthGate
    participant Routes as AuthRoutes
    participant Ctl as Controller.login
    participant Sec as Secrets
    participant DB

    U->>Gate: GET /ui/overview (no cookie)
    Gate-->>U: 303 → /ui/login?next=/ui/overview  (next is validated: same-origin, under /ui only)
    U->>Routes: GET /ui/login (public) → form
    U->>Gate: POST /ui/login {username, password, next}
    Gate->>Gate: public route + Origin check if declared
    Gate->>Routes: pass
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
    L -- yes --> C[principal = OWNER] --> Z[Handler]
    B -- required --> D{Matched route is in<br/>the PUBLIC_ROUTES allowlist?<br/>/api/health · /ui/login · /ui/setup · app.css}
    D -- yes --> E{Unsafe method AND<br/>Origin/Referer declared?}
    E -- "yes, not ours" --> F[403 forbidden_origin]
    E -- otherwise --> Z
    D -- no, incl. unknown paths --> G[Read the fintrack_session cookie]
    G --> H{Cookie present?}
    H -- no --> N
    H -- yes --> I[sha256 token → session row → user]
    I --> J{Valid?<br/>not idle-expired: 7 d sliding<br/>under the 30 d absolute cap<br/>user claimed, not disabled}
    J -- no --> K[Delete the session row] --> N
    J -- yes --> L{Last seen ≥ 5 min ago?}
    L -- yes --> M[Slide expiry: UPDATE session] --> O
    L -- no --> O
    O{Unsafe method?<br/>POST/PUT/PATCH/DELETE}
    O -- yes --> P{Origin equals PUBLIC_URL,<br/>or this loopback host's own origin?}
    P -- no --> F
    P -- yes --> Q
    O -- no --> Q[principal = user] --> Z
    N{Path under /ui?}
    N -- "no: /api, /mcp" --> R[401 JSON unauthenticated]
    N -- yes --> S{Owner unclaimed?}
    S -- yes --> T[303 → /ui/setup]
    S -- no --> U[303 → /ui/login?next=…]
```

## 5. Logout and live dashboards (SSE)

```mermaid
sequenceDiagram
    autonumber
    actor U as User (browser)
    participant Gate as AuthGate
    participant Routes as AuthRoutes
    participant SSE as /ui/events stream
    participant DB

    U->>Gate: GET /ui/events (cookie)
    Gate->>Gate: session valid → principal
    Gate->>SSE: open the stream
    loop every 30 s
        SSE->>DB: re-resolve the session (fails closed on error)
        alt session gone, expired or user disabled
            SSE-->>U: end the stream
        end
    end
    Note over SSE: auth writes (user / session / setup_code) are filtered out of change events

    U->>Gate: POST /ui/logout (cookie + same Origin)
    Gate->>Routes: authenticated + CSRF ok
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
    subgraph L1["Local npm: loopback, no PUBLIC_URL or TRUST_PROXY, only loopback Host/Origin answered"]
      S1[MCP client] -- stdio, trusted --> O1((Owner))
      B1[Browser /ui, /api] -- auth disabled --> O1
    end
    subgraph L2["Docker or exposed: auth required"]
      B2[Browser] -- session cookie + Origin check --> O2((Owner))
      M2[MCP client over HTTP] -. "no cookie: 401<br/>until Phase 2 bearer tokens" .-> X2[rejected]
      H2[Healthcheck] -- /api/health only --> P2[public]
    end
```

## 7. Your existing database through this phase

```mermaid
sequenceDiagram
    autonumber
    participant You as You (stdio, npm)
    participant FT as FinTrack (new version)
    participant DB as ~/.fintrack/fintrack.db

    You->>FT: first start after upgrading
    FT->>DB: migration 0018 pending on an existing DB?
    FT->>DB: VACUUM INTO fintrack.db.pre-0018_auth_identity.bak (encrypted, same key)
    FT->>DB: create users / sessions / setup_codes + INSERT the owner (no credentials)
    Note over DB: no domain table touched — accounts, transactions … unchanged
    FT-->>You: loopback → auth disabled → everything acts as the owner (same behavior as before)
    Note over You,DB: Later (Docker / auth required): setup code → /ui/setup CLAIMS this owner → same data
```
