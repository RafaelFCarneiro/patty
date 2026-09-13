import { z } from 'zod';

/** The write intent a `Persistable` carries — named so call sites construct one via `.enum.*`,
 *  never a bare `'insert'`/`'update'`/`'delete'` string (constants over literals). */
export const PersistOp = z.enum(['insert', 'update', 'delete']);
export type PersistOp = z.infer<typeof PersistOp>;

/** Every entity starts at this version — a structural fact, not a business decision, so a core's
 *  `insert` model never carries it. Each entity's own adapter supplies it when shaping the insert
 *  row, before `runEffects` ever sees the batch — never the database's own `.default(0)`, and
 *  never `diplomat/db`. */
export const INITIAL_VERSION = 0;

/** The optimistic-concurrency version token, declared once instead of per entity. Applied to a
 *  pure domain model via `withPersistenceMeta` — never baked into the model itself, so
 *  `Create*`/wire/out/tool-input shapes stay derived from the unmodified model with no `.omit`s. */
export const PersistenceMeta = z.object({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});

/** `XxxSchema` → `XxxEntitySchema`: the pure model plus `PersistenceMeta`'s `version` field. The
 *  one place every entity's persistence shape is built, so the duplicated version declaration
 *  collapses to this single home. */
export const withPersistenceMeta = <T extends z.ZodRawShape>(model: z.ZodObject<T>) =>
  model.extend(PersistenceMeta.shape);

/**
 * A write intent the functional core hands to the imperative shell (docs/functional-core-imperative-shell.md).
 * Generic over the entity's own tag + model, never a closed union enumerating every entity — each entity
 * module owns its own tag constant (e.g. `models/account.ts`'s `ACCOUNT_ENTITY_TAG`); this file never
 * imports a specific entity's model.
 *
 * `insert` carries the plain domain model, no `version` — a brand-new row always starts at
 * `INITIAL_VERSION`, which isn't something the core decides. It also carries an optional
 * `idempotencyKey` — dedup metadata for the write intent, never a business-model field: an entity
 * opts in by the insert itself carrying a key, written to the fixed `idempotencyKey` column
 * (`versionedTableApplier`, `diplomat/db/effects.ts`). A read-first entity (dashboards, settings)
 * leaves it unset. `update` carries the full desired end-state as the versioned entity —
 * `model.version` is the version the core read; the entity's
 * `EntityApplier` computes the persisted version from it (`model.version + 1`) and applies
 * `... SET ..., version = ? WHERE id = ? AND version = ?`. `delete` carries just the id + the
 * version read, for the same versioned guard.
 */
export type Persistable<Tag extends string = string, Model = unknown> =
  | { op: typeof PersistOp.enum.insert; entity: Tag; model: Model; idempotencyKey?: string }
  | { op: typeof PersistOp.enum.update; entity: Tag; model: Model & { version: number } }
  | { op: typeof PersistOp.enum.delete; entity: Tag; id: string; version: number };

/**
 * What happened when the shell applied one `Persistable` (rule 6). Meaningful chiefly for
 * `insert`: `applied: false` means the write was skipped as an idempotent duplicate, and `read`
 * is the entity's already-decoded model reflecting the existing row, so a flow whose response
 * depends on it doesn't have to re-read the database. `update`/`delete` are always
 * `applied: true` here — a stale `version` already fails as a `conflict` before any outcome is
 * reported (rule 4). `entity` is the tag of the `Persistable` this outcome came from — a flow's
 * own `response` looks up its outcome by tag (`logic/persistence.ts`'s `outcomeFor`), never by
 * position.
 */
export type PersistOutcome = { entity: string; applied: boolean; read?: unknown };

/** What a functional-core flow returns instead of performing its writes: the write batch plus the
 *  response the caller gets once the shell has applied it. `response` is usually just the plain,
 *  core-derived value (rule 6). The exception is an idempotency-aware flow whose response depends
 *  on the apply outcome (e.g. a create's `created` flag): it hands the shell a pure function of
 *  the `PersistOutcome`s instead, called once the batch has committed. Sync only, deliberately —
 *  a flow needing a further write puts it in `persist` too (rule 5); `response` never performs
 *  I/O. */
export type FlowOutcome<T> = {
  persist: Persistable[];
  response: T | ((outcomes: PersistOutcome[]) => T);
};
