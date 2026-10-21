# ADR-024: Local SQLite concurrency posture — WAL + busy_timeout + retry on SQLITE_BUSY

**Status:** Accepted · **Date:** 2026-07-25 · **Deciders:** Rafael · Addresses the **physical** write-contention
axis left open after ADR-015→022 solved **logical** atomicity. Relates to **ADR-004** (local-first encrypted
libSQL), **ADR-007** (stdio the default transport, HTTP opt-in), and the effect runner (**ADR-022**).

## Context

FinTrack is local-first: a single encrypted libSQL (SQLite) file opened in-process (ADR-004). The libSQL client
is created bare — `createClient({ url, encryptionKey })`, no PRAGMAs. That leaves two defaults in force:

- **No `busy_timeout`** — a write that can't immediately acquire SQLite's single write lock fails **instantly**
  with `SQLITE_BUSY` instead of waiting.
- **Rollback-journal mode** (not WAL) — a writer blocks readers and vice-versa; concurrency is worse than it
  needs to be.

Within one process this is invisible: the MCP server, the default-on HTTP sidecar, and scheduled
`apply_due_recurring` share one connection and serialize on the event loop. But **stdio MCP servers are spawned
per client connection** (ADR-007). A user who dogfoods from more than one client — Desktop *and* Cowork/Code, or
a client that reconnects without its first server exiting — ends up with **two `npx fintrack` processes, two
connections, two writers** on the one file.

This was observed, not hypothesized: two concurrent `@rafaelfcarneiro/fintrack@latest` instances (started ~23s
apart) produced frequent `SQLITE_BUSY` on ordinary transaction-category updates. One held the write lock; the
other, with no `busy_timeout`, threw immediately.

A third gap compounds it: **`runEffects` retries `VersionConflict` (optimistic concurrency) but not
`SQLITE_BUSY`.** The applier catch (`diplomat/db/effects.ts`, `applyBatch`) rethrows anything that isn't a
`VersionConflict`, so a raw `SQLITE_BUSY` — a *transient physical* condition a short wait would clear — surfaces
as an unhandled throw (a 500 / tool error), not a retry.

Logical atomicity (ADR-015→022) and physical lock contention are **different axes**. The first was solved; the
second was never configured.

## Decision

Make the local database **contention-tolerant** rather than requiring single-writer discipline. Three changes,
plus one architectural clarification.

1. **WAL journal mode** — `PRAGMA journal_mode = WAL` on open. Readers get a consistent snapshot without blocking
   the single writer; the REST-sidecar-reads + MCP-writes mix stops contending on the reader/writer boundary.
   WAL is a persistent file property (set once, harmless to re-assert each open).

2. **`busy_timeout`** — `PRAGMA busy_timeout = BUSY_TIMEOUT_MS` (proposed **5000**) on **every** connection open
   (busy_timeout is per-connection). A contended writer now *waits* up to that budget for the lock instead of
   throwing. This alone removes essentially all user-visible `SQLITE_BUSY`.

3. **Retry `SQLITE_BUSY` in `runEffects`, bounded** — defense-in-depth for contention that outlives the timeout
   (WAL can still raise `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` under checkpoint starvation). Add `isSqliteBusy`
   (`diplomat/db/sqlite-errors.ts`, same `.code`/extended-code shape as the existing
   `isForeignKeyConstraintViolation`/`isUniqueConstraintViolation` checks); `applyBatch` treats it like a
   `VersionConflict` — roll back and re-invoke the flow, bounded by the existing attempt budget — so physical
   contention degrades to a bounded retry and finally the generic `conflict` error, never a 500.

4. **The transport fork, recorded (not changed):** the multi-writer scenario is **inherent to stdio-per-client**
   (ADR-007). Decisions 1–3 make it *graceful*. The **structural** alternative for heavy multi-client use is the
   **single shared HTTP-transport server** (`MCP_TRANSPORT=http`): one process, one connection, many clients —
   no cross-process contention at all. ADR-007's stdio default stands (it serves the common single-client case
   and binds no port); this ADR documents that **multi-client dogfooding should prefer the HTTP transport**, and
   that 1–3 are what keep stdio-per-client safe when it happens anyway. (`docs/mcp-clients.md` gets the guidance.)

## Options Considered

### A — Status quo; rely on single-instance discipline (rejected)
"Just run one server" is not enforceable and not how multi-client use actually behaves; the failure mode is a
hard, surprising `SQLITE_BUSY` mid-write. The local-first promise includes tolerating ordinary concurrent access.

### B — `busy_timeout` only (partial)
Removes most visible `SQLITE_BUSY` cheaply, but leaves rollback-journal reader/writer blocking on the table and
no safety net for timeout-exceeding contention. WAL is low-cost and the bigger concurrency win.

### C — WAL + `busy_timeout` + bounded BUSY-retry (chosen)
| Dimension | Assessment |
| --- | --- |
| User-visible BUSY | Eliminated in the common case (timeout waits it out); bounded-retried in the rare case |
| Reader/writer concurrency | WAL removes the rollback-journal blocking between the sidecar and the writer |
| Scope | `driver.ts` (two PRAGMAs) + `sqlite-errors.ts`/`effects.ts` (one retryable class) — small |
| Local-first | Preserved — still one encrypted file, zero infra (ADR-004) |
| Cost | WAL sidecar files (`-wal`/`-shm`) to account for in backup; verify WAL + encryption |

### D — Switch the default transport to HTTP single-server, or enforce a single writer (rejected as default)
Would remove contention structurally, but overturning ADR-007's stdio default penalizes the common single-client
case (a bound port, a manual server lifecycle). Kept as the **recommended** posture for multi-client use, not the
default. A hard single-writer lock (advisory lock file) is too restrictive for the dogfooding workflow.

### E — External/hosted DB or a DB server process (rejected)
Violates the local-first, zero-infra posture (ADR-004/005). Not for this release.

## Consequences

- **WAL sidecar files** (`fintrack.db-wal`, `fintrack.db-shm`) appear beside the DB. Backing up or copying the
  database must include them or checkpoint first — documented in `docs/architecture.md`.
- **`runEffects` becomes tolerant of physical contention** — its retry loop now covers `VersionConflict` **and**
  `SQLITE_BUSY`; recorded in `docs/write-path.md` (the effect-runner note) so the two retryable classes are
  explicit.
- **Multi-client stdio use stops being fatal** — it waits/retries instead of throwing; `docs/mcp-clients.md`
  still steers heavy multi-client setups to the HTTP transport.
- **Encryption + WAL must be verified** in implementation (libSQL encryption-at-rest with WAL). If unsupported on
  the target, fall back to `busy_timeout` + retry (decisions 2–3) and note it. This is the one implementation
  risk.
- Durability under WAL is unchanged if `synchronous` is left at its WAL default (`NORMAL`), acceptable for
  local-first; do not lower it further.

## Action Items

1. [x] Review/accept this ADR.
2. [x] `driver.ts`: on `openDatabase`, execute `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`
   (named constants), against the same client, before returning the Drizzle handle. **Verify WAL works with the
   encryption key**; fall back to busy_timeout-only if not, with a note.
3. [x] `sqlite-errors.ts`: add `isSqliteBusy`. `effects.ts`: `applyBatch` treats `SQLITE_BUSY` as a retryable
   conflict (bounded by the existing attempt budget), same rollback-and-re-invoke path as `VersionConflict`.
4. [x] Tests: unit — `SQLITE_BUSY` classified as retryable and bounded; integration — a fresh DB reports
   `journal_mode = wal` and a non-zero `busy_timeout`.
5. [x] Docs: `docs/architecture.md` (persistence concurrency posture + WAL-files backup note), `docs/write-path.md`
   (runner retries `SQLITE_BUSY` too), `docs/mcp-clients.md` (multi-client → prefer HTTP transport); add this ADR
   to the index.

Single PR (small, behind the full gate).
