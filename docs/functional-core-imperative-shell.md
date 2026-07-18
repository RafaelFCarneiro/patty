# Functional Core, Imperative Shell

> **Canonical principle.** Read this in full before writing or reviewing any code that produces a side effect
> (persistence, message dispatch). It is agnostic of any specific domain, entity, or infrastructure — for how
> this project applies it (concrete types, appliers, current state), see `docs/architecture.md`. It sits
> alongside `docs/diplomatic-architecture.md`: Diplomatic Architecture says *where* the layers are; this says
> *what crosses the boundary between them* — **decisions flow out of the core as data; effects are executed by
> the shell.**

## The principle

Split the system into two parts:

- **Functional core** — the domain (controllers, logic, models). Given its inputs and the data it has read, the
  core **decides**. It is a (mostly) pure function from input + data to a **decision**: the response to return
  **and a description of the side effects to perform**. The core performs no writes and dispatches no messages.
- **Imperative shell** — the boundary/infrastructure layer. It reads inputs, invokes the core, **executes** the
  effects the core described — persistence, message dispatch — and returns the core's response.

The core says *what should happen*; the shell *makes it happen*. Persistence and dispatch are side effects that
follow from domain decisions, so they belong to the shell — the component that can be swapped (a different
database, a different transport) without the domain noticing.

## Why

- **Swappable infrastructure.** The domain never names a write mechanism. Change the datastore, the transaction
  strategy, or add message dispatch, and the domain is untouched.
- **Atomicity and concurrency are generic.** The core returns *all* of a flow's effects as one value, so the
  shell executes them as a single unit. There is no flow-specific transactional write method and no per-flow race
  guard — the shell owns atomicity once, generically. This is why infrastructure must never learn a business
  process: a write method that "knows" a multi-step business operation is the exact coupling this principle removes.
- **Pure, fast flow tests.** A flow test invokes the core and asserts on the returned effects — no infrastructure.
  The shell's execution logic is tested once. Atomicity/self-heal tests that only exist because a process leaked
  into infrastructure simply disappear.
- **One place for each concern.** Domain rules live in the core; effect execution lives in the shell; neither
  reaches into the other.

## The rules

1. **The core returns effects as data; it never executes them.** A flow returns a result carrying two things: a
   **description of the effects** to perform and the **response** to return. It composes on the error track, so a
   validation failure short-circuits before any effect is described.

2. **Reads are injected; writes are returned.** The purity boundary is drawn at *mutation and dispatch*, not at
   all I/O. The core still needs data to decide, so it **reads** through injected query dependencies — reads are
   safe, idempotent, and never the thing that needs a transaction. What leaves the core is the **write intent**,
   as data. The core's injected dependencies expose **queries and pure helpers only** — never write methods.

3. **An effect is a tagged intent over a domain value, not an operation script.** Each effect names its target
   (an entity tag), an operation (insert / update / delete, or dispatch), and carries the domain value in the
   core's own vocabulary. The effect description is **generic** — the shared type never enumerates specific
   entities; each entity contributes its own tag. Translating a domain value into its stored/wire form happens
   once, at the boundary, before the shell's generic engine sees it — not inside the engine and not inside a
   business rule. The engine dispatches each effect to a per-entity handler registered by tag; handlers do only
   the mechanical operation, identical for any entity following the shared conventions, and never encode a
   business process. Adding a new entity is registration, never a new branch inside the engine.

4. **Concurrency rides on the value as a version.** Every mutable entity carries a version. An update effect
   carries the version the core read; the shell applies it conditioned on that version and computes the next
   version itself — the datastore never owns version bookkeeping. A stale version means the read is out of date:
   the shell discards the unit and **re-runs the core** (fresh reads, fresh decision), bounded, then surfaces a
   generic conflict. Optimistic concurrency, expressed as one ordinary field the core returns and enforced
   **generically by the shell** — no compare-and-set predicates, and zero business knowledge in infrastructure.

5. **Composition is merging.** When a flow orchestrates other flows, it takes their effect descriptions and
   **merges** them with its own; the merged set executes as one unit. A flow that needs another context's write
   asks that context's flow for the *effects*, and never touches its storage.

6. **The response is the core's, derived from the values it already holds.** The core minted the identifiers and
   built the values, so it returns the response without reading anything back. The exception is
   **outcome-dependent** responses (e.g. an idempotent create that must report created-vs-already-present): those
   need the shell's per-effect outcome, so the shell returns it and the core's response is a function of it.

7. **Effects come in kinds, and a flow declares its granularity.** The shell's execution surface has a small,
   closed set of effect **kinds** — a **write** (persistence), the **response** (always produced), and
   **dispatch** (an outbound message) — each executed by its own generic shell mechanism; the core only ever
   describes an effect by kind and payload, never performs one. Independently, a flow declares its
   **granularity**: a **single atomic unit** — one batch, applied together, all-or-nothing, where a failure
   discards the whole unit and re-invokes the core for a fresh decision — or a **sequence of independent
   units**, where each unit is applied and retried on its own so one unit's failure does not roll back the
   others (partial success), and the shell reports a per-unit outcome alongside the flow's overall result.
   Both granularities follow the same principle — the core describes, the shell executes and owns retry — at
   a different boundary of "what commits together"; a flow picks whichever grain matches what it is actually
   declaring: one indivisible change, or many independently-meaningful ones.

## What this is not

- **Not "the core does no I/O."** It reads. It just does not *write* or *dispatch*.
- **Not an ORM unit-of-work / change-tracker.** The core hands the shell an explicit set of effects; the shell
  does not diff or track entities behind the scenes.
- **Not a generic god-changeset.** Effects are typed, entity-tagged intents over the domain's own values, not an
  untyped list of column operations.

## Relationship to Diplomatic Architecture

Complementary. Diplomatic Architecture defines the layers and their dependency direction — the domain must not
depend on infrastructure, adapters translate at the boundary, the boundary stays thin. Functional Core /
Imperative Shell sharpens **what the domain hands the boundary**: not a call into a write mechanism, but a value
describing the effects. The boundary layer *is* the imperative shell.

## Testing implications

- **Flow (core) tests** assert on the returned effects + response — pure, no infrastructure. "Performing X
  produces an insert of A and a version-guarded update of B" is an assertion on data.
- **The shell's engine** is tested once, generically, per granularity it implements: unit atomicity and
  version-conflict → discard → re-run for a single atomic unit; per-unit retry and partial success for a
  sequence of independent units. Outcome-dependent results are tested either way.
- Flow-specific atomicity / self-heal tests are **removed** — the conditions they guarded no longer exist,
  because the flow no longer executes its own effects.
