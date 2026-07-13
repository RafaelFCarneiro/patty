import { and, eq } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { conflict } from '../../models/error.js';
import { PersistOp, type Persistable } from '../../models/persistable.js';
import type { Db } from './driver.js';

// First-attempt call to `flow` plus this many retries on a version conflict, each re-invoking
// `flow` for a fresh read → fresh decision (docs/functional-core-imperative-shell.md rule 4).
const MAX_UNIT_OF_WORK_ATTEMPTS = 3;

/** The transaction handle `db.transaction` hands its callback — inferred from `Db` itself so this
 *  file never names a drizzle-internal type directly. Exported so each entity's `EntityApplier`
 *  (which runs inside that same transaction) can type its methods against it. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * What an entity module supplies so this generic shell can apply a `Persistable` tagged with its
 * entity, without this file ever naming that entity: the actual drizzle table op. `insert`/`update`
 * receive an already db-row-shaped `model` — the model→row adaptation (`modelToDb`) happens
 * upstream, at the MCP/REST handler that calls `unitOfWork` (e.g. `adapters/accounts.ts`'s
 * `persistableToDb`, run via `outcomeToDb` before the batch ever reaches here), not inside this
 * file or inside the applier: `diplomat/db` only ever writes the row it's handed, never adapts
 * one. Built once per entity (e.g. `diplomat/db/repos/accounts.ts`'s `accountApplier`) and
 * registered under that entity's own tag — see `ApplierRegistry`. `insert`/`update` take `unknown`
 * because this file has no entity-specific row type to name; the applier that receives it is the
 * one place that knows how to interpret it.
 */
export type EntityApplier = {
  insert: (tx: Tx, model: unknown) => Promise<void>;
  /** Returns whether the versioned WHERE guard matched (`rowsAffected > 0`). */
  update: (tx: Tx, model: unknown) => Promise<boolean>;
  /** Returns whether the versioned WHERE guard matched (`rowsAffected > 0`). */
  delete: (tx: Tx, id: string, version: number) => Promise<boolean>;
};

/** Every entity tag a converted flow might produce a `Persistable` for, mapped to how to apply
 *  one. Assembled once at the composition root (`main.ts`) from each entity's own applier — this
 *  file only ever looks values up in it, never lists an entity itself. */
export type ApplierRegistry = Record<string, EntityApplier>;

/** A table shaped for `versionedTableApplier` below: an `id` + `version` column, by the exact
 *  property names every mutable table's row already uses (schema.ts). True for 8 of the 9
 *  mutable tables — `dashboards` keys on `name` instead, so it needs its own hand-written
 *  `EntityApplier` rather than this factory. */
type VersionedTable = SQLiteTable & { id: AnySQLiteColumn; version: AnySQLiteColumn };

/**
 * Builds an `EntityApplier` for any table that follows the `id`/`version` convention — the
 * mechanics (insert with `onConflictDoNothing`, `... SET ..., version = version + 1 WHERE id = ?
 * AND version = ?`, delete under the same guard) are identical for every such table, so an entity
 * whose table fits this shape (most of them) never hand-writes its own applier; it just calls
 * `versionedTableApplier(itsTable)`. `model` still arrives already db-row-shaped (`diplomat/db`
 * never adapts — see `EntityApplier` above), so this only ever destructures and writes it.
 */
export const versionedTableApplier = <T extends VersionedTable>(table: T): EntityApplier => ({
  insert: async (tx, model) => {
    await tx
      .insert(table)
      .values(model as never)
      .onConflictDoNothing();
  },

  update: async (tx, model) => {
    const { id, version, ...values } = model as Record<string, unknown> & { id: string; version: number };
    const result = await tx
      .update(table)
      .set({ ...values, version: version + 1 } as never)
      .where(and(eq(table.id, id), eq(table.version, version)));
    return (result.rowsAffected ?? 0) > 0;
  },

  delete: async (tx, id, version) => {
    const result = await tx.delete(table).where(and(eq(table.id, id), eq(table.version, version)));
    return (result.rowsAffected ?? 0) > 0;
  },
});

/** Marks "a versioned op affected zero rows" up through `db.transaction`'s promise rejection so
 *  the whole batch rolls back; caught by `applyBatch`, never leaks past this file. */
class VersionConflict extends Error {}

const resolveApplier = (registry: ApplierRegistry, entity: string): EntityApplier => {
  const applier = registry[entity];
  if (!applier) throw new Error(`withUnitOfWork: no applier registered for entity "${entity}"`);
  return applier;
};

const applyPersistable = async (tx: Tx, registry: ApplierRegistry, p: Persistable): Promise<void> => {
  const applier = resolveApplier(registry, p.entity);
  switch (p.op) {
    case PersistOp.enum.insert:
      // onConflictDoNothing is the applier's own concern (e.g. a retried insert after an apply
      // that actually committed is an idempotent no-op, not a version conflict) — inserts never
      // retry here regardless of what an applier does internally.
      await applier.insert(tx, p.model);
      return;
    case PersistOp.enum.update: {
      const matched = await applier.update(tx, p.model);
      if (!matched) throw new VersionConflict();
      return;
    }
    case PersistOp.enum.delete: {
      const matched = await applier.delete(tx, p.id, p.version);
      if (!matched) throw new VersionConflict();
      return;
    }
    default: {
      const _exhaustive: never = p;
      throw new Error(`withUnitOfWork: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Applies the whole batch in one transaction; `true` on success, `false` on a version conflict
 *  (the transaction has already rolled back in that case). Any other failure propagates. */
const applyBatch = async (db: Db, registry: ApplierRegistry, persist: Persistable[]): Promise<boolean> => {
  try {
    await db.transaction(async (tx) => {
      for (const p of persist) await applyPersistable(tx, registry, p);
    });
    return true;
  } catch (cause) {
    if (cause instanceof VersionConflict) return false;
    throw cause;
  }
};

type Flow<T> = () => ResultAsync<{ persist: Persistable[]; response: T }, AppError>;

const attempt = <T>(db: Db, registry: ApplierRegistry, flow: Flow<T>, attemptsLeft: number): ResultAsync<T, AppError> =>
  flow().andThen(({ persist, response }) =>
    ResultAsync.fromSafePromise(applyBatch(db, registry, persist)).andThen((applied) => {
      if (applied) return okAsync(response);
      if (attemptsLeft <= 1) return errAsync<T, AppError>(conflict);
      return attempt(db, registry, flow, attemptsLeft - 1);
    }),
  );

/**
 * The generic versioned unit of work (ADR-021 / docs/functional-core-imperative-shell.md): runs
 * `flow`, applies the `persist` batch it returns in one `db.transaction` by dispatching each
 * `Persistable` to the `registry`'s applier for its entity, and returns `flow`'s `response`. This
 * file has no knowledge of any specific entity — no `EntityTag.enum.*` switch, no entity's
 * `modelToDb`/table import — only the `registry` (built once at the composition root) does. A
 * version-guarded op that affects zero rows rolls back the whole batch and re-invokes `flow` — a
 * fresh read, a fresh decision — up to `MAX_UNIT_OF_WORK_ATTEMPTS` times, then surfaces the
 * generic `conflict` error. `diplomat/db` is the only place that touches `Db` for a converted
 * flow; controllers and `diplomat/mcp`/`diplomat/http` see only the `UnitOfWork` function shape
 * (`controllers/deps.ts`).
 */
export const withUnitOfWork = <T>(db: Db, registry: ApplierRegistry, flow: Flow<T>): ResultAsync<T, AppError> =>
  attempt(db, registry, flow, MAX_UNIT_OF_WORK_ATTEMPTS);
