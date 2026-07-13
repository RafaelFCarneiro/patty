import { and, eq } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { conflict } from '../../models/error.js';
import { EntityTag, PersistOp, type Persistable } from '../../models/persistable.js';
import * as accountAdapters from '../../adapters/accounts.js';
import type { Db } from './driver.js';
import { accounts } from './schema.js';

// First-attempt call to `flow` plus this many retries on a version conflict, each re-invoking
// `flow` for a fresh read → fresh decision (docs/functional-core-imperative-shell.md rule 4).
const MAX_UNIT_OF_WORK_ATTEMPTS = 3;

/** The transaction handle `db.transaction` hands its callback — inferred from `Db` itself so this
 *  file never names a drizzle-internal type directly. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Marks "a versioned op affected zero rows" up through `db.transaction`'s promise rejection so
 *  the whole batch rolls back; caught by `applyBatch`, never leaks past this file. */
class VersionConflict extends Error {}

const applyInsert = async (tx: Tx, p: Extract<Persistable, { op: typeof PersistOp.enum.insert }>): Promise<void> => {
  switch (p.entity) {
    case EntityTag.enum.account:
      // onConflictDoNothing: a PK collision (e.g. a retried insert after an apply that actually
      // committed) is an idempotent no-op, not a version conflict — inserts never retry.
      await tx.insert(accounts).values(accountAdapters.modelToDb(p.model)).onConflictDoNothing();
      return;
    default: {
      const _exhaustive: never = p.entity;
      throw new Error(`withUnitOfWork: unhandled insert entity ${JSON.stringify(_exhaustive)}`);
    }
  }
};

const applyUpdate = async (tx: Tx, p: Extract<Persistable, { op: typeof PersistOp.enum.update }>): Promise<void> => {
  switch (p.entity) {
    case EntityTag.enum.account: {
      // Drop `id`/`version` from the row and key off `p.model` directly instead: drizzle's
      // insert-row type marks a `.default(...)` column optional, but `p.model` (an `AccountEntity`)
      // guarantees both are present. The new version is computed here, in application code, from
      // the version the core read (`p.model.version`) — never as an opaque `version + 1` expression
      // left for the database engine to evaluate; the shell only ever writes a value the model
      // handed it.
      const { id: _id, version: _readVersion, ...values } = accountAdapters.modelToDb(p.model);
      const result = await tx
        .update(accounts)
        .set({ ...values, version: p.model.version + 1 })
        .where(and(eq(accounts.id, p.model.id), eq(accounts.version, p.model.version)));
      if ((result.rowsAffected ?? 0) === 0) throw new VersionConflict();
      return;
    }
    default: {
      const _exhaustive: never = p.entity;
      throw new Error(`withUnitOfWork: unhandled update entity ${JSON.stringify(_exhaustive)}`);
    }
  }
};

const applyDelete = async (tx: Tx, p: Extract<Persistable, { op: typeof PersistOp.enum.delete }>): Promise<void> => {
  switch (p.entity) {
    case EntityTag.enum.account: {
      const result = await tx.delete(accounts).where(and(eq(accounts.id, p.id), eq(accounts.version, p.version)));
      if ((result.rowsAffected ?? 0) === 0) throw new VersionConflict();
      return;
    }
    default: {
      const _exhaustive: never = p.entity;
      throw new Error(`withUnitOfWork: unhandled delete entity ${JSON.stringify(_exhaustive)}`);
    }
  }
};

const applyPersistable = (tx: Tx, p: Persistable): Promise<void> => {
  switch (p.op) {
    case PersistOp.enum.insert:
      return applyInsert(tx, p);
    case PersistOp.enum.update:
      return applyUpdate(tx, p);
    case PersistOp.enum.delete:
      return applyDelete(tx, p);
    default: {
      const _exhaustive: never = p;
      throw new Error(`withUnitOfWork: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Applies the whole batch in one transaction; `true` on success, `false` on a version conflict
 *  (the transaction has already rolled back in that case). Any other failure propagates. */
const applyBatch = async (db: Db, persist: Persistable[]): Promise<boolean> => {
  try {
    await db.transaction(async (tx) => {
      for (const p of persist) await applyPersistable(tx, p);
    });
    return true;
  } catch (cause) {
    if (cause instanceof VersionConflict) return false;
    throw cause;
  }
};

type Flow<T> = () => ResultAsync<{ persist: Persistable[]; response: T }, AppError>;

const attempt = <T>(db: Db, flow: Flow<T>, attemptsLeft: number): ResultAsync<T, AppError> =>
  flow().andThen(({ persist, response }) =>
    ResultAsync.fromSafePromise(applyBatch(db, persist)).andThen((applied) => {
      if (applied) return okAsync(response);
      if (attemptsLeft <= 1) return errAsync<T, AppError>(conflict);
      return attempt(db, flow, attemptsLeft - 1);
    }),
  );

/**
 * The generic versioned unit of work (ADR-021 / docs/functional-core-imperative-shell.md): runs
 * `flow`, applies the `persist` batch it returns in one `db.transaction` via the per-entity
 * `modelToDb` adapter, and returns `flow`'s `response`. A version-guarded `update`/`delete` that
 * affects zero rows rolls back the whole batch and re-invokes `flow` — a fresh read, a fresh
 * decision — up to `MAX_UNIT_OF_WORK_ATTEMPTS` times, then surfaces the generic `conflict` error.
 * `diplomat/db` is the only place that touches `Db` for a converted flow; controllers and
 * `diplomat/mcp`/`diplomat/http` see only the `UnitOfWork` function shape (`controllers/deps.ts`).
 */
export const withUnitOfWork = <T>(db: Db, flow: Flow<T>): ResultAsync<T, AppError> =>
  attempt(db, flow, MAX_UNIT_OF_WORK_ATTEMPTS);
