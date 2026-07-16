# Functional Core, Imperative Shell

> **Canonical principle.** Read this in full before writing or reviewing any code that produces a side effect
> (persistence, message dispatch). It sits alongside `docs/diplomatic-architecture.md`: Diplomatic Architecture
> says *where* the layers are; this says
> *what crosses the boundary between them* — **decisions flow out of the core as data; effects are executed by
> the shell.**
>
> **Status: Adopted** (ADR-021). Phase 1 (groundwork + `createAccount` as the first converted flow), phase 2a
> (the account-context transaction flows — `add_account_expense`/`add_account_income`/`create_transfer`/
> `update_account_transaction`/`delete_account_transaction` — plus the `PersistOutcome` idempotency-outcome
> plumbing rule 6 describes), phase 2b (the credit-card transaction flows — `add_card_purchase`/
> `update_card_transaction`/`delete_card_transaction`, including `billApplier`'s cycle-uniqueness-race-as-retry
> handling), phase 2c (the bill flows — `pay_bill`/`revert_bill_payment`, completing the transaction+bill
> write path and deleting the last bill write methods — `deps.bills.markPaid`/`revertPayment`/`setStatus`), and
> phase 3a (the simple entity CRUD flows — `update_account`/`delete_account`, `create_tag`/`delete_tag`,
> `create_category`/`delete_category`/`create_sub_category`/`delete_sub_category`,
> `create_credit_card`/`delete_credit_card` — including `tagApplier`'s own beyond-`id`/`version` mechanics, a
> two-entity batch for credit-card create, `deleteCreditCard`'s own domain-decided cascade of every correlated
> bill/transaction ahead of the card, and `merchant_category`'s cleanup on category delete moved to a
> schema-declared `ON DELETE CASCADE` rather than either the domain or an applier deciding it) are implemented,
> including phase 3d's own removal of every `deps` write method these five entities' flows turned out to have no
> other caller for (`accounts.update`/`.delete`, `tags.create`/`.delete`, `categories.create`/`.delete`,
> `subCategories.create`/`.delete`, `creditCards.deleteCard`); the
> remaining flows (bulk import, recurring — phase 3b/3c) still drive their own persistence via injected repo
> write methods until that phase converts them, and *those* entities' now-unused write methods are removed only
> once their own callers convert — this principle is the target shape for every one of them, not yet the
> as-built state of the whole write path.

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

3. **A `Persistable` is a tagged domain model, not an operation script — and the tagging scaffolding is itself
   entity-agnostic.** It is a discriminated union over the entity, carrying a domain model and an intent:

   ```ts
   type Persistable<Tag extends string = string, Model = unknown> =
     | { op: 'insert'; entity: Tag; model: Model }                       // full new entity (id minted by the core)
     | { op: 'update'; entity: Tag; model: Model & { version: number } } // full desired end-state; model carries `version`
     | { op: 'delete'; entity: Tag; id: string; version: number }
   ```

   `Persistable` is generic, never a closed union enumerating every entity — the shared type never imports a
   specific entity's model. Each entity owns its own tag as a plain constant on its own model file (e.g.
   `ACCOUNT_ENTITY_TAG`), so converting a new flow never means editing the shared `Persistable`/`PersistOp`
   file. The write intent itself (`PersistOp`: `insert`/`update`/`delete`) is a named enum (constants over
   literals), shared across every entity since the three operations themselves are truly generic.

   The core speaks in **models** (its own vocabulary); by the time a `Persistable` reaches the shell's generic
   engine (`withUnitOfWork`), it must already speak **rows**. The `modelToDb` adaptation is **not** the
   engine's job, and not the entity's applier's job either — it happens once, explicitly, at the MCP/REST
   handler that calls `unitOfWork`, immediately after the controller returns and before the batch is handed
   over (e.g. `adapters/accounts.ts`'s `outcomeToDb`, mapped over the whole batch). Every entity's
   `persistableToDb`/`outcomeToDb` pair is built by the same shared factory
   (`logic/persistence.ts`'s `entityDbAdapter(entityTag, modelToDb)`) from just its own `modelToDb` — the
   adapter-side twin of `versionedTableApplier` below, for the same reason: the op-switch (no-op on a
   foreign tag, bake in `INITIAL_VERSION` on insert, shape the model on update, pass `delete` through
   untouched) is identical for every entity. The engine dispatches each already-row-shaped `Persistable` to
   the entity's own applier — an object exposing
   generic `insert`/`update`/`delete` methods that do only the matching table op, nothing else. Because the
   adaptation already happened, those methods are pure mechanics — cast the row, write it, guard on `version`
   — identical for any table keyed by `id` with a `version` column, which most tables are; such an entity
   never hand-writes its own applier at all, it builds one from a single shared factory
   (`versionedTableApplier(itsTable)`) parameterized only by the table reference. The shell's generic engine
   never names a specific entity: it looks the applier up in a registry keyed by `entity`, assembled once at
   the composition root from every converted entity's own applier. Adding a new converted entity (that fits
   the `id`/`version` convention) means one line at the composition root — never a new `case` inside the
   engine itself, and never a `modelToDb` call inside `diplomat/db`.

4. **Concurrency rides on the model as `version`.** Every mutable entity carries a `version`. An `update`
   persistable carries the version the core read; the shell applies it as
   `UPDATE … SET …, version = <read version + 1> WHERE id = ? AND version = ?` — the new version is computed
   in application code from the persistable's own `version` field (`model.version + 1`), never as an opaque
   `version + 1` expression left for the database engine to evaluate; the database never owns version
   bookkeeping on its own, it only ever writes the exact value the shell hands it. A `rowsAffected === 0` is a
   stale read → the shell rolls back the whole unit of work and **re-runs the core** (fresh reads, fresh
   decision), bounded, then surfaces a generic `conflict` error. Optimistic concurrency, expressed as one
   ordinary field the core returns and enforced **generically by the shell** — no CAS predicates, and **zero
   business knowledge in the repo**.

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
