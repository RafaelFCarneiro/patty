# ADR-030: Extract the effect engine into a DB-agnostic core behind an explicit adapter port

**Status:** Proposed · **Date:** 2026-09-13 · **Deciders:** Rafael · Delivers **ADR-029 Phase 3** (the deferred
"extract the DB-agnostic core") at the **3a** scope agreed there: split a driver-free effect-engine core with an
explicit adapter **port**, keep SQLite as the sole adapter. A **networked/Postgres backend is explicitly out of
scope** (3b) — it reopens the local-first foundation (ADR-004/005/007/013/024) and hosted/auth deferred in
PLAN Phase 4, and gets its own strategic ADR. Builds on ADR-021/022/023 (FC/IS write path) and ADR-029
(managed-entity contract). Behavior-preserving.

**The stated destination** (why this boundary matters): the effect engine is meant to become its **own project —
a standalone library** FinTrack depends on, so FinTrack sheds the engine's structure/responsibility and keeps
only its actual purpose, **financial management**. The internal `src/effects/` module here is step one, drawn so
it can later be lifted into its own repo/package with **zero FinTrack-specific code** and imported back as a
dependency. That destination is a *harder* constraint than "driver-free": `effects/` must also carry no FinTrack
domain, no FinTrack error taxonomy, and own its own data contract (see § Decision).

## Context

The write-path engine (`diplomat/db/effects.ts`) tangles three concerns in one file, sitting inside the SQLite
diplomat:

- **Pure core** — `runEffects`/`runEffectsSequence`: the attempt/retry loop (`MAX_RUN_EFFECTS_ATTEMPTS`), batch
  orchestration, `PersistOutcome`/response shaping, `VersionConflict` semantics, the post-commit change-event
  publish hook. DB-agnostic in spirit.
- **The port** — `EntityApplier` (insert/update/delete over a `Tx`), `ApplierRegistry`, `ReadBack`, and the
  "is this failure retryable?" classification the retry loop depends on. This is the core↔adapter contract.
- **The SQLite adapter** — `versionedTableApplier` (Drizzle `and`/`eq`, `SQLiteTable`/`AnySQLiteColumn`),
  `sqliteErrors.ts` (`LibsqlError` code matching), `Tx` derived from the libSQL Drizzle handle (`driver.ts`).

The core reaches into the adapter today via: `import { and, eq } from 'drizzle-orm'`, the sqlite-core column/table
types, `type Tx = Parameters<Db['transaction']>[0][0]`, and `isSqliteBusy`/`isForeignKeyConstraintViolation`.
ADR-029 already kept the *data* contract (`Persistable`, `PersistenceMeta`, `INITIAL_VERSION`) driver-free in
`models/persistable.ts`; this ADR does the same for the *engine* and formalizes the seam so a second adapter
(Postgres, later) is a matter of implementing the port — not editing the core.

## Decision

Extract a **driver-free effect-engine core** into a new top-level module **`src/effects/`**, define the **adapter
port** it depends on, and make **`diplomat/db` the SQLite adapter** that implements the port. Wiring stays at the
composition root (`main.ts`), which already builds `runEffects` and injects it via `McpContext`/`HttpContext`.
This is, for now, an **internal module boundary rather than a separate repo/package** — the actual repo split +
publish is the *destination* (above), sequenced after the boundary proves out, not this ADR's phases. But the
module is drawn to that destination from the start: `effects/` owns its contract and carries no FinTrack code, so
the later lift-out is a move, not a rewrite.

### The core (`src/effects/`, no Drizzle, no sqlite)

- `runEffects` / `runEffectsSequence` — the retry loop, batch orchestration, outcome/response shaping, the
  post-commit publish hook. Generic over an **opaque transaction handle** `Tx` (a type parameter): the core
  threads `tx` from the runner to the appliers without knowing its shape.
- `VersionConflict` — the core-owned sentinel appliers throw for a stale version / unique-or-FK race; the core
  catches it (and transient contention, below) and retries.
- Port **types**: `EntityApplier<Tx>`, `ApplierRegistry<Tx>`, `ReadBack<Tx>`, `PublishChange`.
- **Owns the data contract.** The `Persistable`/`PersistOutcome`/`FlowOutcome`/`PersistenceMeta`/
  `withPersistenceMeta`/`INITIAL_VERSION` set (ADR-029 parked it in `models/persistable.ts` before this module
  existed) **moves into `effects/`** — it was always engine-level, not FinTrack domain. FinTrack's `models/`
  import it *from* `effects/`. `effects/` imports it from nowhere below itself.
- **No FinTrack error taxonomy.** `runEffects` today returns `ResultAsync<T, AppError>` and emits FinTrack's
  `conflict()` — a coupling to FinTrack's error union. For a clean lib the engine is **generic over its error
  type** (or owns a minimal `ConflictError`) and the shell maps it into `AppError` at the composition root.
- **Dependencies:** only third-party generics (`zod`, `neverthrow`, `remeda`). No `diplomat/`, no FinTrack
  `models/`/`common/`, no driver — a build-visible/lint-enforced rule. That is what makes the later repo lift-out
  a move rather than a rewrite.

### The port (what the adapter must provide)

- **`TransactionRunner`** — `runInTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>`: opens a unit of
  work, commits on success, rolls back on throw. Replaces the core's current direct `Db.transaction(...)`.
- **`EntityApplier<Tx>`** implementations per entity (the adapter's `versionedTableApplier` builds these).
- **`isTransientContention(cause): boolean`** — the retry classifier (today `isSqliteBusy`). The core's retry
  predicate becomes `cause instanceof VersionConflict || ctx.isTransientContention(cause)` — no sqlite import in
  the core. The unique/FK→`VersionConflict` translation stays inside the adapter's applier (where the driver
  error is known), throwing the core's `VersionConflict`.

### The SQLite adapter (`diplomat/db`)

- `versionedTableApplier` (Drizzle `and`/`eq`, `SQLiteTable`), `sqliteErrors.ts` (implements
  `isTransientContention` + the unique/FK detection), `driver.ts` (provides `runInTransaction` from the libSQL
  Drizzle handle and the concrete `Tx` type). Implements the port; imports `effects/`, never the reverse.

## Options considered

- **Extract to an internal `src/effects/` module + explicit port (chosen).** Establishes the driver-free boundary
  and the exact interface a future Postgres adapter implements, with zero behavior change and the existing
  integration suites as proof. Cost: a mechanical relocation + threading an opaque `Tx` type param + one port
  interface.
- **Split to its own repo + publish the package now (rejected *timing*, not direction).** The repo/package IS
  the destination — but doing it before the internal boundary is proven adds release/versioning overhead and
  churn while the port is still settling. Draw the clean internal boundary first; the lift-out is then a move.
- **Leave the engine in `diplomat/db`, just add interfaces (rejected).** Keeps the core physically inside the
  SQLite diplomat, so "core imports no driver" isn't structurally enforceable — the coupling creeps back. A
  separate module makes a Drizzle import in the core a build-visible error.
- **Full Postgres adapter now (rejected — deferred to 3b).** Reopens local-first/auth/encryption/deployment and
  a parallel pg-core schema + FTS; a strategic pivot, not this bounded refactor.

## Consequences

- **The core is provably driver-free** — a Drizzle/libSQL import in `src/effects/` is a reviewable (and
  lint-enforceable) violation, the same way `logic/` may not import `diplomat/`. This is the guarantee that makes
  a second adapter possible.
- **The port is the explicit contract** a future adapter implements: a `TransactionRunner`, per-entity
  `EntityApplier`s, and `isTransientContention`. 3b (Postgres) becomes "implement the port + a pg-core schema,"
  not "edit the engine."
- **Behavior-preserving** — same retry semantics, same outcomes, same publish hook. `test/integration/db/effects.test.ts`
  and every flow suite are the proof; a behavior diff there is a smell (only import paths move).
- **Dependency direction:** `effects/` ← FinTrack `models/`/`diplomat/db` (adapter) ← composition root. `effects/`
  depends only on third-party generics (`zod`, `neverthrow`, `remeda`) — **not** FinTrack `models/`/`common/` or
  `diplomat/` — so it is self-contained and lift-out-ready. Recorded in `docs/architecture.md`'s dependency table.
- **Docs:** `docs/write-path.md` (the engine now lives in `effects/` behind a port; the adapter is `diplomat/db`);
  `docs/architecture.md` (dependency table + ADR index); `CLAUDE.md`/copilot layer rules gain "`effects/` is
  driver-free; `diplomat/db` is its SQLite adapter."

## Migration plan (phased — behind the full gate, behavior-preserving)

1. **`refactor/effect-port-seam`** — introduce the port *in place* (still in `diplomat/db`): a `TransactionRunner`
   abstraction wrapping `Db.transaction`, and `isTransientContention` replacing the core's direct `isSqliteBusy`
   call; make `runEffects`/`EntityApplier` generic over an opaque `Tx`. No file moves yet — proves the seam with
   the smallest diff. Integration suites unchanged.
2. **`refactor/effect-engine-module`** — relocate the driver-free core (`runEffects`/`runEffectsSequence`,
   `VersionConflict`, the port types, `MAX_RUN_EFFECTS_ATTEMPTS`) **plus the data contract**
   (`Persistable`/`PersistenceMeta`/`withPersistenceMeta`/`INITIAL_VERSION`, moved out of `models/persistable.ts`)
   to `src/effects/`; decouple the engine from FinTrack's error taxonomy (generic error param or an engine-owned
   `ConflictError` the shell maps to `AppError`); leave `versionedTableApplier`, `sqliteErrors`, `driver`, and the
   concrete `Tx` in `diplomat/db` implementing the port; update imports + composition-root wiring. Add the lint
   rule forbidding `zod`/`neverthrow`/`remeda`-only in `effects/` (no `diplomat`/FinTrack `models`/`common`/driver).
   Docs updated.
3. **(Deferred, own ADR) repo/package extraction** — lift `src/effects/` into its own project and publish it as a
   library FinTrack depends on (the stated destination). A mechanical move once Phase 2's boundary holds.
4. **(Deferred, own ADR) 3b** — a Postgres/other adapter + the local-first-vs-hosted decision. Out of scope here.

## Action Items

1. [ ] Review/accept this ADR.
2. [x] Phase 1 — port seam in place (`TransactionRunner`, `isTransientContention`, opaque `Tx`); behavior-preserving.
3. [ ] Phase 2 — relocate the driver-free core **and the data contract** to `src/effects/`; decouple from
   FinTrack's error taxonomy; `diplomat/db` implements the port; lint rule + dependency-table entry;
   `docs/write-path.md` + `docs/architecture.md` updated.
4. [ ] (Deferred, own ADR) lift `src/effects/` into its own repo + publish as a library FinTrack depends on
   (the stated destination).
5. [ ] (Deferred, own ADR) 3b — Postgres/other backend adapter, gated on the local-first-vs-hosted decision.

Each phase is feature-sized (spans the write-path engine, multiple layers) → independent verification subagent
per diff, charged with confirming the core takes **no** Drizzle/sqlite/`diplomat`/FinTrack-`models`/`common`
import (only `zod`/`neverthrow`/`remeda`), behavior is unchanged (no diff to the effects/flow integration suites
beyond import paths), and the port is the sole core↔adapter seam.
