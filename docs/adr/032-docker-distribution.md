# ADR-032: Docker distribution — container image, HTTP transport by default, SQLite on a volume

**Status:** Accepted · **Date:** 2026-10-06 · **Deciders:** Rafael · Adds a second way to run FinTrack (a
container image) alongside the npm package. Builds on ADR-004/005 (encrypted local libSQL, keychain key),
ADR-007 (stdio default, HTTP opt-in), ADR-013 (HTTP sidecar serving REST + `/ui`), ADR-024 (single-process
SQLite concurrency). **Authentication is out of scope here and is the gate for any exposure beyond the host
machine** — it gets its own ADR (ADR-033). Postgres/multi-process (ADR-030/031 "3b") stays parked.

## Context

FinTrack today is installed as an npm package and spawned by an MCP client over stdio, with an HTTP sidecar for
REST and the dashboards. The goal is to also run it as a **self-contained container**: start it, and the UI, the
MCP endpoint, and the REST API are all reachable, with data persisting across restarts — independent of any
particular AI client.

Most of this is already supported. `MCP_TRANSPORT=http` serves REST (`/api`), MCP (`/mcp`), and the dashboards
(`/ui`) from one Fastify port; migrations and seeds run at startup; `/api/status` exists; SIGTERM shuts down
cleanly. Four things block a good container today:

1. **The bind host is hardcoded** to `LOOPBACK_HOST` (`127.0.0.1`) in `main.ts` (pure HTTP mode) and
   `server.ts` (the sidecar). Inside a container, loopback is unreachable from the host.
2. **The encryption key comes from the OS keychain** (`@napi-rs/keyring`), which a container doesn't have.
   `FINTRACK_DB_KEY` (env var) is the only alternative, and env vars are visible in `docker inspect`.
3. **`@napi-rs/keyring` is imported at module top level** in `driver.ts`, so its native module loads even when
   the key comes from the environment — forcing keychain/D-Bus libraries into the image for nothing.
4. **No image, no build, no publish.**

The loopback binding is deliberate: the API has **no authentication**, and binding the wildcard address was
verified to expose it to the whole LAN. That constraint survives into the container world unchanged.

## Decision

Ship an **official container image** on **GitHub Container Registry**, configured for HTTP transport, with the
SQLite database on a volume and the encryption key supplied as a secret. Local (npm) defaults are unchanged.

### 1. Runtime seams (code)

- **Configurable bind host.** New `HOST` setting (zod-validated in `config.ts`), default `127.0.0.1` —
  identical behavior for npm/local runs. Both listen sites (`main.ts`, `server.ts`) use it; the startup banners
  print a reachable URL rather than the literal bind address (`0.0.0.0` is not a URL a user can open).
- **Key from a file.** New `FINTRACK_DB_KEY_FILE` (path, e.g. `/run/secrets/fintrack_db_key`). Resolution order:
  `FINTRACK_DB_KEY_FILE` → `FINTRACK_DB_KEY` → OS keychain. Setting both file and env var is a startup error
  (ambiguous). The file's contents get the same 64-hex validation.
- **No auto-generated key in the container.** If no key source is available and the keychain is unavailable,
  fail fast with an actionable message (`openssl rand -hex 32` → a Docker secret). The key is **never** written
  to the data volume — a key stored next to the data defeats encryption at rest.
- **Lazy keychain import.** `@napi-rs/keyring` is loaded only on the keychain path (dynamic import), so the image
  never needs it to load.

### 2. The image

- **Base:** glibc-based Node slim image matching `engines.node` (`@libsql/client` ships native bindings;
  musl/Alpine is avoided). Multi-stage: build stage compiles `dist/`; runtime stage carries `dist/`, `drizzle/`,
  `ui/`, `skills/`, and production dependencies only.
- **Defaults baked in:** `MCP_TRANSPORT=http`, `HOST=0.0.0.0`, `PORT=51737`, `DB_PATH=/data/fintrack.db`.
  Everything stays overridable by env.
- **Data:** `VOLUME /data` — the database and its WAL sidecar files (`-wal`, `-shm`) live there together.
- **Hardening:** runs as a non-root user; the only writable path is `/data`.
- **Process:** Node runs as PID 1 behind an init (`--init`/tini) so SIGTERM reaches the existing graceful
  shutdown; `HEALTHCHECK` hits `/api/status`.
- **One replica.** SQLite + the in-process change bus + the in-process scheduler mean exactly one container per
  volume. Documented explicitly; horizontal scaling is a 3b (Postgres + a multi-process change bus) concern.

### 3. Exposure policy (until ADR-033)

The container must bind `0.0.0.0` internally, so **safety moves to the host-side port publish**: every shipped
example — `compose.yaml`, README, client docs — publishes on host loopback only
(`127.0.0.1:51737:51737`). Docs state plainly that publishing on all interfaces exposes an unauthenticated
finance API to the network, and that ADR-033 (auth) is what makes that safe.

### 4. Publish

- Images go to `ghcr.io/rafaelfcarneiro/fintrack`, **multi-arch** (`linux/amd64`, `linux/arm64`).
- Tags: the release version (`X.Y.Z`, `X.Y`, `X`) and `latest`, aligned with the npm package version.
- **Built in the existing `release.yml`**, as a job after semantic-release, gated on "a release was cut" and using
  its version output. (A separate `on: release` workflow would not fire: releases created with the default
  `GITHUB_TOKEN` don't trigger other workflows.) `ci.yml` additionally builds the image (no push) on PRs so a
  broken Dockerfile is caught before release.

### 5. Clients

With HTTP as the container default, MCP clients connect by URL (`http://127.0.0.1:51737/mcp`) instead of
spawning a process. `docs/mcp-clients.md` gains a Docker section per client; the exact path for each client
(native HTTP support vs. a local bridge) is verified when that doc is written, not assumed here.

## Options considered

- **Official image on GHCR (chosen)** vs Docker Hub — GHCR sits next to the repo, uses the same GitHub auth and
  release automation, and needs no second account.
- **Key as a required secret (chosen)** vs auto-generate on first run — auto-generation in a container can only
  store the key on the volume (no keychain), which puts the key next to the data it protects.
- **Configurable `HOST`, default loopback (chosen)** vs hardcoding `0.0.0.0` in container mode — one explicit
  setting keeps npm behavior byte-identical and makes the exposure decision visible in config.
- **Loopback-only publishing until auth (chosen)** vs shipping open by default — the API has no auth; an open
  default would expose financial data to the LAN.
- **Postgres now (rejected — parked as 3b)** — SQLite on a volume is sufficient for a single-user container and
  changes nothing in the data layer.

## Consequences

- **A second distribution channel** (image) next to npm, released from the same commit and version.
- **New config:** `HOST`, `FINTRACK_DB_KEY_FILE`. npm/local defaults unchanged (stdio, loopback, keychain).
- **The image is single-replica by design**; docs say so.
- **Until ADR-033 lands, the container is a local-machine deployment**, safe only with loopback publishing.
- **Docs:** README (Docker quick start), `docs/releasing.md` (image publishing), `docs/mcp-clients.md` (Docker
  section), `docs/architecture.md` (HTTP sidecar/transport section + config table + ADR index), `CLAUDE.md`
  development setup (Docker run line).

## Migration plan (phased — behind the full gate)

1. **`feat/container-ready-runtime`** — `HOST` setting used by both listen sites (default `127.0.0.1`, banners
   print reachable URLs); `FINTRACK_DB_KEY_FILE` with the resolution order + ambiguity error; fail-fast message
   when no key source exists; lazy `@napi-rs/keyring` import. Tests: config validation (HOST, key file, both-set
   error), key resolution order, no keychain import on the env/file paths. npm behavior unchanged.
2. **`feat/docker-image`** — multi-stage `Dockerfile`, `.dockerignore`, `compose.yaml` (loopback publish, `/data`
   volume, key as a Docker secret), healthcheck, non-root user, init; `ci.yml` image build on PRs; `release.yml`
   multi-arch build + push to GHCR after semantic-release; docs.
3. **(Next ADR) ADR-033 — authentication**: UI login, REST tokens, MCP authorization. Unlocks exposure beyond the
   host.

## Action Items

1. [x] Review/accept this ADR (accepted 2026-10-06).
2. [x] Phase 1 — container-ready runtime seams.
3. [x] Phase 2 — image, compose, CI build, GHCR publish, docs.
4. [ ] ADR-033 — authentication (gate for non-loopback exposure).

Each phase is feature-sized (config + startup path, or new build/release infrastructure) → independent
verification subagent per diff, charged with confirming npm/local behavior is unchanged, the key never lands on
the volume, and every shipped example publishes on loopback only.
