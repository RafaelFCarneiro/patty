# Functional Core, Imperative Shell

> **Canonical principle.** Read this in full before writing or reviewing any code that produces a side effect
> (persistence, message dispatch). It sits alongside `docs/diplomatic-architecture.md`: Diplomatic Architecture
> says *where* the layers are; this says
> *what crosses the boundary between them* — **decisions flow out of the core as data; effects are executed by
> the shell.**
>
> **Status: Adopted** (ADR-021). Phase 1 (groundwork + `createAccount` as the first converted flow) is
> implemented; the remaining write flows still drive their own persistence via injected repo write methods
> until phases 2–3 convert them — this principle is the target shape for every one of them, not yet the as-built
> state of the whole write path.

## The principle

Split the system into two parts:

- **Functional core** — the domain: `controllers/`, `logic/`, `models/`. Given its inputs and the data it has
  read, the core **decides**. It is a (mostly) pure function from input+data to **a decision**: the response to
  return **and a description of the side effects to perform**. The core performs **no** writes and dispatches
  **no** messages.
- **Imperative shell** — the diplomat layer: `diplomat/db`, `diplomat/http`, `diplomat/mcp`. It reads inputs,
  invokes the core, and **executes** the effects the core described — persistence, messaging — then returns the
  core's response.

The core says *what should happen*; the shell *makes it happen*. Persistence and dispatch are side effects that
follow from domain decisions, so they belong to the shell — the component that can be swapped (a different
database, a different transport) without the domain noticing.

## Why

- **Swappable infrastructure.** The domain never names a write mechanism. Change the database, the transaction
  strategy, or add an outbox for messaging, and the domain is untouched.
- **Atomicity and concurrency are generic.** Because the core returns *all* of a flow's writes as one batch, the
  shell applies them in a single unit of work. No flow-specific transactional repo method, no per-flow race
  guard — the shell owns atomicity once, generically. (This is why the repo must never learn a business process:
  a repo method that "knows" a bill payment is a transfer plus a status flip is the exact coupling this
  principle removes.)
- **Pure, fast flow tests.** A flow test calls the core and asserts on the returned effects — no database. The
  shell's apply logic is tested once. Concurrency/atomicity/self-heal tests that only exist because a process
  leaked into the repo simply disappear.
- **One place for each concern.** Domain rules live in the core; effect execution lives in the shell; neither
  reaches into the other.

## The rules

1. **The core returns effects as data; it never executes them.** A controller returns
   `ResultAsync<{ persist: Persistable[]; response: T }, AppError>` (composed with neverthrow's `safeTry`; the
   core still performs injected reads, so it stays async). `persist` is
   the batch of writes; `response` is what the caller gets back.

2. **Reads are injected; writes are returned.** The purity boundary is drawn at *mutation and dispatch*, not at
   all I/O. The core still needs data to decide, so it **reads** through injected query dependencies
   (`deps.<x>.get/find/search`) — reads are safe, idempotent, and never the thing that needs a transaction.
   What leaves the core is the **write intent**, as `Persistable[]`. `deps` therefore exposes **queries and
   pure helpers** (`newId`, `clock`, `locale`) — never write methods.

3. **A `Persistable` is a tagged domain model, not an operation script.** It is a discriminated union over the
   entity, carrying a domain model and an intent:

   ```ts
   type Persistable =
     | { op: 'insert'; entity: EntityTag; model: <DomainModel> }   // full new entity (id minted by the core)
     | { op: 'update'; entity: EntityTag; model: <DomainModel> }   // full desired end-state; model carries `version`
     | { op: 'delete'; entity: EntityTag; id: string; version: number }
   ```

   The core speaks in **models** (its own vocabulary); the shell runs each through the existing `modelToDb`
   adapter and the matching table op. `EntityTag` is a named enum (constants over literals) so the dispatch is
   exhaustively typed — never a stringly god-changeset.

4. **Concurrency rides on the model as `version`.** Every mutable entity carries a `version`. An `update`
   persistable carries the version the core read; the shell applies it as
   `UPDATE … SET …, version = version + 1 WHERE id = ? AND version = ?`. A `rowsAffected === 0` is a stale
   read → the shell rolls back the whole unit of work and **re-runs the core** (fresh reads, fresh decision),
   bounded, then surfaces a generic `conflict` error. Optimistic concurrency, expressed as one ordinary field
   the core returns and enforced **generically by the shell** — no CAS predicates, and **zero business
   knowledge in the repo**.

5. **Composition is concatenation.** When a flow orchestrates other controllers, it calls them, takes their
   `persist` batches, and **merges** them with its own; the merged batch applies atomically in one unit of work.
   A controller that needs another aggregate's write asks that aggregate's controller for the *persistables* and
   never touches its tables.

6. **The response is the core's, derived from the models it already holds.** The core minted the ids and built
   the full models, so it returns the response without reading anything back. The exception is
   **idempotency-aware** flows (e.g. bulk import), which need the shell's per-item apply outcome
   (inserted / duplicate-skipped) to shape their response — for those, the shell returns the batch outcome and
   the core's response is a function of it.

## What this is not

- **Not "the core does no I/O."** It reads. It just doesn't *write*.
- **Not an ORM unit-of-work / change-tracker.** The core hands the shell an explicit batch; the shell does not
  diff or track entities behind the scenes.
- **Not a generic god-changeset.** `Persistable` is a typed, entity-tagged union of the project's own models,
  not an untyped list of column ops.

## Relationship to Diplomatic Architecture

Complementary. Diplomatic Architecture (`docs/diplomatic-architecture.md`) defines the layers and their
dependency direction — the domain must not import `diplomat/*`, adapters translate at the boundary, `diplomat/*`
stays thin. Functional Core / Imperative Shell sharpens **what the domain hands the boundary**: not calls into a
write mechanism, but a value describing the writes. The diplomat layer is the imperative shell; `modelToDb`
adapters are how a returned model becomes a row; the unit of work is the shell executing the batch.

## Testing implications

- **Flow (core) tests** assert on the returned `{ persist, response }` — pure, no database. "Paying a bill
  produces an insert of the payment transfer and a version-guarded update of the bill to `paid`" is a pure
  assertion on data.
- **The unit of work** is tested once, generically: batch atomicity, version-conflict → rollback → retry,
  idempotent-insert outcomes.
- Flow-specific atomicity / self-heal / "ensure-and-attach" tests are **removed** — the conditions they guarded
  no longer exist, because the flow no longer applies its own writes.
