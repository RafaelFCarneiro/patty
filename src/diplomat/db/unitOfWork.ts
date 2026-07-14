import { and, eq } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { conflict } from '../../models/error.js';
import { PersistOp, type FlowOutcome, type Persistable, type PersistOutcome } from '../../models/persistable.js';
import type { Db } from './driver.js';

// Total calls to `flow` across the whole unit of work — the first attempt plus up to
// (MAX_UNIT_OF_WORK_ATTEMPTS - 1) retries on a version conflict, each re-invoking `flow` for a
// fresh read → fresh decision (docs/functional-core-imperative-shell.md rule 4). Exported so
// tests assert against the real policy instead of duplicating the literal.
export const MAX_UNIT_OF_WORK_ATTEMPTS = 3;

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
 * one place that knows how to interpret it. Each method returns a `PersistOutcome` (models/
 * persistable.ts) — `applied` drives this file's own retry/conflict decision (rule 4); an applier
 * that has nothing else to report just returns `{ applied }`, e.g. `versionedTableApplier` below.
 */
export type EntityApplier = {
  insert: (tx: Tx, model: unknown) => Promise<PersistOutcome>;
  update: (tx: Tx, model: unknown) => Promise<PersistOutcome>;
  delete: (tx: Tx, id: string, version: number) => Promise<PersistOutcome>;
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
 * mechanics (insert with `onConflictDoNothing` scoped to the `id` conflict target only — so a
 * genuine violation of some other unique column on the table, e.g. `tags.name` or
 * `transactions.idempotencyKey`, surfaces as a real error instead of being silently swallowed as
 * if it were the same-id idempotent-retry case — `... SET ..., version = <read version + 1> WHERE
 * id = ? AND version = ?` — the new version computed right below in application code from the
 * row's own `version` field, never a SQL-side `version + 1` expression the database engine
 * evaluates on its own — delete under the same guard) are identical for every such table, so an
 * entity whose table fits this shape (most of them) never hand-writes its own applier; it just
 * calls `versionedTableApplier(itsTable)`. `model` still arrives already db-row-shaped
 * (`diplomat/db` never adapts — see `EntityApplier` above), so this only ever destructures and
 * writes it.
 */
export const versionedTableApplier = <T extends VersionedTable>(table: T): EntityApplier => ({
  insert: async (tx, model) => {
    const result = await tx
      .insert(table)
      .values(model as never)
      .onConflictDoNothing({ target: table.id });
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },

  update: async (tx, model) => {
    const row = model as Record<string, unknown> & { id: string; version: number };
    const values = R.omit(row, ['id', 'version']);
    const result = await tx
      .update(table)
      .set({ ...values, version: row.version + 1 } as never)
      .where(and(eq(table.id, row.id), eq(table.version, row.version)));
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },

  delete: async (tx, id, version) => {
    const result = await tx.delete(table).where(and(eq(table.id, id), eq(table.version, version)));
    return { applied: (result.rowsAffected ?? 0) > 0 };
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

const applyPersistable = async (tx: Tx, registry: ApplierRegistry, p: Persistable): Promise<PersistOutcome> => {
  const applier = resolveApplier(registry, p.entity);
  switch (p.op) {
    case PersistOp.enum.insert:
      // onConflictDoNothing is the applier's own concern (e.g. a retried insert after an apply
      // that actually committed is an idempotent no-op, not a version conflict) — inserts never
      // retry here regardless of what an applier does internally; its outcome is only ever
      // reported onward, never itself a reason to throw.
      return applier.insert(tx, p.model);
    case PersistOp.enum.update: {
      const outcome = await applier.update(tx, p.model);
      if (!outcome.applied) throw new VersionConflict();
      return outcome;
    }
    case PersistOp.enum.delete: {
      const outcome = await applier.delete(tx, p.id, p.version);
      if (!outcome.applied) throw new VersionConflict();
      return outcome;
    }
    default: {
      const _exhaustive: never = p;
      throw new Error(`withUnitOfWork: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Applies the whole batch in one transaction, returning each persistable's own outcome
 *  (positional, parallel to `persist`) on success — empty on a version conflict, since the
 *  transaction has already rolled back and there is nothing to report. Any other failure
 *  propagates. */
const applyBatch = async (
  db: Db,
  registry: ApplierRegistry,
  persist: Persistable[],
): Promise<{ applied: boolean; outcomes: PersistOutcome[] }> => {
  const outcomes: PersistOutcome[] = [];
  try {
    await db.transaction(async (tx) => {
      for (const p of persist) outcomes.push(await applyPersistable(tx, registry, p));
    });
    return { applied: true, outcomes };
  } catch (cause) {
    if (cause instanceof VersionConflict) return { applied: false, outcomes: [] };
    throw cause;
  }
};

type Flow<T> = () => ResultAsync<FlowOutcome<T>, AppError>;

/** Resolves a `FlowOutcome`'s `response` against the batch's apply outcomes — the plain value for
 *  the common case, or the result of calling the function an idempotency-aware flow handed back
 *  instead (rule 6). Sync — see `models/persistable.ts`'s `FlowOutcome` doc for why. */
const resolveResponse = <T>(response: T | ((outcomes: PersistOutcome[]) => T), outcomes: PersistOutcome[]): T =>
  typeof response === 'function' ? (response as (o: PersistOutcome[]) => T)(outcomes) : response;

const attempt = <T>(db: Db, registry: ApplierRegistry, flow: Flow<T>, attemptsLeft: number): ResultAsync<T, AppError> =>
  flow().andThen(({ persist, response }) =>
    ResultAsync.fromSafePromise(applyBatch(db, registry, persist)).andThen(({ applied, outcomes }) => {
      if (applied) return okAsync(resolveResponse(response, outcomes));
      if (attemptsLeft <= 1) return errAsync<T, AppError>(conflict);
      return attempt(db, registry, flow, attemptsLeft - 1);
    }),
  );

/**
 * The generic versioned unit of work (ADR-021 / docs/functional-core-imperative-shell.md): runs
 * `flow`, applies the `persist` batch it returns in one `db.transaction` by dispatching each
 * `Persistable` to the `registry`'s applier for its entity, and returns `flow`'s `response`. This
 * file has no knowledge of any specific entity — no per-entity switch statement, no entity's
 * `modelToDb`/table import — only the `registry` (built once at the composition root) does. A
 * version-guarded op that affects zero rows rolls back the whole batch and re-invokes `flow` — a
 * fresh read, a fresh decision — up to `MAX_UNIT_OF_WORK_ATTEMPTS` times, then surfaces the
 * generic `conflict` error. `diplomat/db` is the only place that touches `Db` for a converted
 * flow; controllers and `diplomat/mcp`/`diplomat/http` see only the `UnitOfWork` function shape
 * (`controllers/deps.ts`).
 */
export const withUnitOfWork = <T>(db: Db, registry: ApplierRegistry, flow: Flow<T>): ResultAsync<T, AppError> =>
  attempt(db, registry, flow, MAX_UNIT_OF_WORK_ATTEMPTS);
