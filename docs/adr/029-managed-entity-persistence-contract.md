# ADR-029: Managed-entity persistence contract — an engine-owned base for id/version/idempotency, and the seam for a DB-agnostic effect engine

**Status:** Accepted · **Date:** 2026-09-08 · **Deciders:** Rafael · Refines **ADR-021/022/023** (the FC/IS
write path — the domain returns effects as data, a generic shell applies them; appliers decide and read
nothing). Realizes the parked **#134** (idempotency key's "honest home" is the write envelope, not a business
model field). Keeps the id/version/idempotency **three-concepts-distinct** ground rule intact. Sets up — but
does not itself perform — a future extraction of the effect engine into a standalone, DB-agnostic library
(Postgres and other backends), which will get its own ADR.

## Context

The metadata the effect engine needs to manage a write — **id**, **version** (optimistic-concurrency token),
and an optional **idempotency key** — is real and already separated by concept, but it's declared in scattered,
partly-duplicated places:

- **version** is added per entity via `XxxEntitySchema = XxxSchema.extend({ version: z.number().int()
  .nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out') })`. That identical
  `describe` string is copy-pasted across every entity (`models/budget.ts`, `models/transaction.ts`'s
  `RawTransactionViewSchema`, …) — a constants-over-literals smell by our own CLAUDE.md item 3.
- **idempotency key** sits *inside the business model* for transactions (`TransactionSchema.idempotencyKey`,
  `CreateTransactionSchema.idempotencyKey`) **and** is named again in registration config
  (`versionedTableApplier(transactions, { idempotencyColumn: 'idempotencyKey' })`). #134's point: a business
  model shouldn't carry the engine's dedup key.
- **id** is a surrogate on every row.

Two forces make this worth addressing now:

1. **#134** — the idempotency key belongs to the *write intent* (the `Persistable` envelope the core hands the
   shell), not to the domain model whose business fields flow into `Create*`/`wire/out`/tool-input shapes.
2. **Portability north star** — FinTrack should be able to run on Postgres (and others), which means eventually
   extracting the effect engine into a standalone library. A library can only be DB-and-domain-agnostic if its
   contract does **not** reach into FinTrack's zod business models. So *where* the shared "engine metadata"
   base lives decides whether that extraction is later mechanical or a coupling nightmare.

The engine contract is already largely generic: `Persistable<Tag, Model>`, `EntityApplier`, `ApplierRegistry`,
`FlowOutcome`, `runEffects`/`runEffectsSequence`, and per-entity registration config. The DB-specific part is
isolated in `versionedTableApplier` (Drizzle/SQLite). This ADR tightens that seam rather than inventing it.

## Decision

Introduce an **engine-owned persistence-metadata contract, applied *to* pure domain models — never baked into
them** (the rejected alternative). Three parts:

### 1. `PersistenceMeta` + `withPersistenceMeta` — the version token, declared once

A single engine/persistence-layer schema owns the version token and the "Model → Entity" step:

The contract lives in **`models/persistable.ts`** — already the Drizzle-free, entity-agnostic write-intent
module (`Persistable`, `FlowOutcome`, `INITIAL_VERSION`) that imports no specific entity model, so it is the
natural nucleus of the future portable core (no new folder needed; the extraction seam is "the pure pieces of
`models/persistable.ts` + `effects.ts`'s `runEffects`/registry, **minus** `versionedTableApplier`").

```ts
// models/persistable.ts — the DB-agnostic persistence contract (future lib core)
export const PersistenceMeta = z.object({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export const withPersistenceMeta = <T extends z.ZodRawShape>(model: z.ZodObject<T>) =>
  model.extend(PersistenceMeta.shape);
```

Each entity's persistence shape becomes `XxxEntitySchema = withPersistenceMeta(XxxSchema)` — the duplicated
`version` declaration collapses to one home. The **pure domain model stays pure** (`XxxSchema` unchanged), so
`Create*`, `wire/out`, and MCP tool-input shapes derive from it exactly as today, with no new `.omit`s. This
preserves the standing invariant that **`version` never appears on a public model/wire shape** — it lives only
on the persistence `Entity` shape and the `update`/`delete` `Persistable`.

### 2. Idempotency moves onto the write-intent envelope (realizes #134)

The caller-supplied idempotency key stops being a business-model field and becomes **optional metadata on the
`insert` `Persistable`**:

```ts
| { op: 'insert'; entity: Tag; model: Model; idempotencyKey?: string }
```

- `TransactionSchema` (the domain entity) **drops** `idempotencyKey` as a business field; `CreateTransactionSchema`
  (wire/in) and `TransactionViewSchema` (wire/out) keep it unchanged — a boundary input a caller/derivation still
  supplies, not a domain field. The flows that build the insert (single add + bulk import) set it on the envelope
  instead (the same derived `date+description+amount` key, currency-decimals-aware per #176 — unchanged).
- The engine dedups on the envelope key; the **applier** (`versionedTableApplier`) now **writes** it to the
  physical column via registration (`idempotencyColumn` names the column, not a model field to read) — that
  mapping is an adapter concern, correct to keep.
- **Idempotency stays OPTIONAL and distinct.** Entities that decide insert-vs-update by a **core read-first**
  (dashboards, settings) carry no key and are untouched. This is the guardrail on the ground rule: id, version,
  and idempotency remain three separate, independently-present fields — one *declaration discipline*, never one
  fused mechanism (the id is never the dedup key; version is never dedup).

### 3. The portability seam, made explicit (extraction is a later ADR)

This ADR draws the line the future lib will cut along, and keeps the **core free of Drizzle imports** so the cut
is mechanical when it comes:

- **Portable core (DB-agnostic):** `Persistable`, `PersistOutcome`, `FlowOutcome`, `EntityApplier`,
  `ApplierRegistry`, `runEffects`/`runEffectsSequence`, `PersistenceMeta`/`withPersistenceMeta`,
  `INITIAL_VERSION`. Depends on no specific entity model and no DB driver.
- **DB adapter (swappable):** `versionedTableApplier` + table wiring — Drizzle/libSQL today; a `pgTableApplier`
  implementing the same `EntityApplier` primitives later. The registration config (`idempotencyColumn`,
  `readBack`) is the adapter's contract with the core.

Actually publishing the core as a package and adding a Postgres adapter is **out of scope here** — it gets its
own ADR when it lands. This ADR only ensures nothing in the core reaches into the domain or the driver.

## Options considered

- **Engine-owned contract applied to pure models (chosen).** Models stay pure; one home for the version token;
  idempotency on the envelope; the contract is the extractable core. Cost: a mechanical refactor across every
  `XxxEntitySchema` + the transaction idempotency move.
- **A `BaseEntitySchema` in `models/` that every domain model extends (rejected).** Re-introduces
  version/idempotency onto the pure business model, forcing `.omit` across every `Create*`/`wire` shape, and —
  fatally for the north star — makes the future lib depend on FinTrack's zod models. Inverts the coupling the
  extraction needs.
- **Status quo (rejected).** Leaves the version `describe` duplicated per entity and idempotency half-in-model,
  half-in-registration; #134 stays open.
- **Idempotency on the envelope (chosen) vs a business-model field (status quo).** The key is a property of the
  write intent, not the entity; the envelope is its honest home (#134). It keeps the *domain entity* free of a
  concern that isn't a business field — `Create*` (wire/in) and `wire/out` legitimately keep it, since a caller
  still supplies/derives the key and the read view still reflects the stored column; only `TransactionSchema`
  itself sheds it.

## Consequences

- **`models/`:** every `XxxEntitySchema` becomes `withPersistenceMeta(XxxSchema)`; the duplicated `version`
  declaration is gone. `TransactionSchema` (the domain entity) loses `idempotencyKey` — it moves to the envelope;
  `CreateTransactionSchema` (wire/in) and `TransactionViewSchema` (wire/out) are unaffected, since a caller still
  supplies/derives the key and the read view still reflects the stored column. `StatementLine`/bulk plumbing set
  it on the insert `Persistable`.
- **`Persistable`:** the `insert` variant gains optional `idempotencyKey`; `logic/persistence.ts`'s `insert`
  builder accepts it. `effects.ts`/`versionedTableApplier` write the key from the envelope onto the registered
  column (adapter no longer reads it off the model). Behavior-preserving — same dedup outcome, same
  `created: false` on duplicate.
- **Invariants preserved:** version stays off wire/out; id/version/idempotency stay three distinct concepts;
  read-first-dedup entities are untouched.
- **Core stays Drizzle-free** — a prerequisite for the future extraction; a Drizzle import creeping into the
  core module is now a reviewable smell.
- **Docs:** `docs/write-path.md` (the envelope now carries the idempotency key; the managed-entity base),
  `docs/architecture.md` (§ Write path guardrails + ADR index; the "version never on wire" invariant now points
  at `PersistenceMeta`), `CLAUDE.md` data-conventions idempotency line.
- Feature-sized and multi-layer → independent verification subagent per phase.

## Migration plan (phased — behind the full gate)

1. **`refactor/persistence-meta`** — introduce `PersistenceMeta` + `withPersistenceMeta`; convert every
   `XxxEntitySchema`/`Raw*ViewSchema` version-extend to use it. Purely behavior-preserving (the emitted schemas
   are identical); the win is one declaration home. Existing tests are the proof.
2. **`refactor/idempotency-on-envelope`** (realizes #134) — add optional `idempotencyKey` to the `insert`
   `Persistable` + `logic/persistence.ts`'s `insert`; move the key off `TransactionSchema` (the domain entity) —
   `CreateTransactionSchema` (wire/in) and `TransactionViewSchema` (wire/out) keep it unchanged, since a caller
   still supplies/derives it and the read view still reflects the stored column — and set it on the envelope in
   the single-add + bulk-import flows; `effects.ts`/`versionedTableApplier` write it from the envelope onto the
   registered column, `idempotencyColumn` naming that column rather than a model field to read. Behavior-preserving
   dedup; tests for duplicate-still-deduped + read-first entities unaffected. Close #134.
3. **(Future, separate ADR)** — extract the DB-agnostic core into a package; add a Postgres `EntityApplier`
   adapter. Not in this ADR beyond keeping the core driver-free.

## Action Items

1. [x] Review/accept this ADR (accepted 2026-09-08; contract lives in `models/persistable.ts`).
2. [x] Phase 1 — `PersistenceMeta`/`withPersistenceMeta`; convert the per-entity version-extends.
3. [x] Phase 2 — idempotency key onto the `insert` envelope; drop it from the transaction business model; close #134.
4. [x] Record in `docs/architecture.md` (ADR index + the version/idempotency invariant wording) and
   `docs/write-path.md`; update the `CLAUDE.md` idempotency data-convention line.
5. [ ] (Deferred, own ADR) extract the core as a lib + Postgres adapter.

Each phase is feature-sized → independent verification subagent per diff, charged with confirming the core takes
no Drizzle/domain-model dependency, version stays off wire/out, and idempotency remains optional (read-first
entities untouched).
