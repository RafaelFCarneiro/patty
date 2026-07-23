import { and, eq } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { errAsync, okAsync, type Result, ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { conflict } from '../../models/error.js';
import { PersistOp, type FlowOutcome, type Persistable, type PersistOutcome } from '../../models/persistable.js';
import type { Db } from './driver.js';
import { isForeignKeyConstraintViolation } from './sqliteErrors.js';

// A version conflict re-invokes `flow` for a fresh read → fresh decision
// (docs/functional-core-imperative-shell.md rule 4), up to this many attempts total. Exported so
// tests assert the real policy instead of duplicating the literal.
export const MAX_RUN_EFFECTS_ATTEMPTS = 3;

/** The transaction handle `db.transaction` hands its callback — inferred from `Db` itself rather
 *  than naming a drizzle-internal type directly. Exported so each `EntityApplier` (which runs
 *  inside that same transaction) can type its methods against it. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** An applier's own outcome, before `applyPersistable` stamps its `Persistable`'s entity tag onto
 *  it — an applier never states its own tag, since the same applier can be registered under
 *  whatever tag the composition root chooses. */
type ApplierOutcome = Omit<PersistOutcome, 'entity'>;

/**
 * What an entity module supplies so this generic shell can apply a `Persistable` tagged with its
 * entity, without this file ever naming that entity. `insert`/`update` receive an already
 * db-row-shaped `model` — the model→row adaptation happens upstream, at the handler that calls
 * `runEffects`, never here — so `unknown` is deliberate: this file has no entity-specific row
 * type to name. Each method returns an `ApplierOutcome`; `applied` drives this file's own
 * retry/conflict decision (rule 4).
 */
export type EntityApplier = {
  insert: (tx: Tx, model: unknown) => Promise<ApplierOutcome>;
  update: (tx: Tx, model: unknown) => Promise<ApplierOutcome>;
  delete: (tx: Tx, id: string, version: number) => Promise<ApplierOutcome>;
};

/** Every entity tag a converted flow might produce a `Persistable` for, mapped to how to apply
 *  it — assembled once at the composition root; this file only ever looks values up in it, never
 *  lists an entity itself. */
export type ApplierRegistry = Record<string, EntityApplier>;

/** An `id` + `version` column shape, matching most mutable tables — a table outside the
 *  convention (the link/key-only tables carry no `id`/`version` at all) hand-writes its own
 *  `EntityApplier` instead. */
type VersionedTable = SQLiteTable & { id: AnySQLiteColumn; version: AnySQLiteColumn };

/** An entity's own post-write projection, supplied at registration: invoked after a successful
 *  insert/update with the id of the row that actually persisted (on an idempotent duplicate, the
 *  surviving row's — never the discarded mint), returning the decoded view that lands on
 *  `PersistOutcome.read`. The one sanctioned entity-supplied hook performing a read inside the
 *  engine — a recorded deviation from FC/IS rules 3/6 (`docs/architecture.md` § Write path); a
 *  second entity-supplied hook is the signal this design is wrong (ADR-023 option D). */
export type ReadBack = (tx: Tx, id: string) => Promise<unknown>;

type VersionedTableConfig<T extends VersionedTable> = {
  /** The row field (drizzle column property name) carrying the entity's caller-supplied
   *  idempotency key, opting it into the engine's generic idempotency treatment: when a row
   *  carries a value here, `insert` conflict-targets this column — the dedup contract "a row with
   *  this key already exists" makes the existing row the outcome. Distinct from, and never merged
   *  with, the id-scoped conflict target: that one is a structural retry guard, not idempotency
   *  (ADR-023). */
  idempotencyColumn?: Extract<keyof T, string>;
  readBack?: ReadBack;
};

/**
 * Builds an `EntityApplier` for any table following the `id`/`version` convention. Two mechanics
 * worth knowing: `insert`'s `onConflictDoNothing` is scoped to a single conflict target (the
 * registered idempotency column when the row carries a key, else `id`), so a genuine violation of
 * any other unique column (e.g. `tags.name`) still surfaces as a real error instead of being
 * swallowed as a same-id retry; and the next `version` is computed here in application code from
 * the row's own field, never a SQL-side `version + 1` the database evaluates on its own.
 */
export const versionedTableApplier = <T extends VersionedTable>(
  table: T,
  config: VersionedTableConfig<T> = {},
): EntityApplier => {
  const { idempotencyColumn, readBack } = config;
  const keyColumn = idempotencyColumn ? (table[idempotencyColumn] as AnySQLiteColumn) : undefined;

  const keyOf = (row: Record<string, unknown>): string | undefined => {
    if (!idempotencyColumn) return undefined;
    const value = row[idempotencyColumn];
    // A nullish key means "no idempotency for this row" — never a conflict target (SQL NULLs
    // don't conflict, which would silently disable the id guard too).
    return typeof value === 'string' ? value : undefined;
  };

  // The engine's one idempotency read: which row already holds the key a just-conflicted insert
  // carried. Runs inside the same transaction as the no-op'd insert, so absence is an invariant
  // violation, not an expected miss.
  const findSurvivingRowId = async (tx: Tx, column: AnySQLiteColumn, key: string): Promise<string> => {
    const [row] = await tx.select({ id: table.id }).from(table).where(eq(column, key));
    if (!row) throw new Error(`runEffects: no surviving row holds idempotency key "${key}" after a duplicate insert`);
    return row.id as string;
  };

  return {
    insert: async (tx, model) => {
      const row = model as Record<string, unknown> & { id: string };
      const key = keyOf(row);
      const result = await tx
        .insert(table)
        .values(row as never)
        .onConflictDoNothing({ target: key !== undefined && keyColumn ? keyColumn : table.id });
      const applied = (result.rowsAffected ?? 0) > 0;
      if (!readBack) return { applied };

      // On an idempotent duplicate the persisted row is the one already holding the key — the
      // minted `row.id` was never inserted, so the projection must read the survivor instead.
      const persistedId =
        applied || key === undefined || !keyColumn ? row.id : await findSurvivingRowId(tx, keyColumn, key);
      return { applied, read: await readBack(tx, persistedId) };
    },

    update: async (tx, model) => {
      const row = model as Record<string, unknown> & { id: string; version: number };
      const values = R.omit(row, ['id', 'version']);
      const result = await tx
        .update(table)
        .set({ ...values, version: row.version + 1 } as never)
        .where(and(eq(table.id, row.id), eq(table.version, row.version)));
      const applied = (result.rowsAffected ?? 0) > 0;
      if (!applied || !readBack) return { applied };
      return { applied, read: await readBack(tx, row.id) };
    },

    delete: async (tx, id, version) => {
      try {
        const result = await tx.delete(table).where(and(eq(table.id, id), eq(table.version, version)));
        return { applied: (result.rowsAffected ?? 0) > 0 };
      } catch (cause) {
        // A row referencing this one was inserted after the flow's read — the same "world changed"
        // condition a stale version reports, just surfaced by the FK check instead.
        if (isForeignKeyConstraintViolation(cause)) throw new VersionConflict();
        throw cause;
      }
    },
  };
};

/** Signals "roll back the whole batch and re-invoke the flow for a fresh read/decision" up
 *  through `db.transaction`'s rejection; caught by `applyBatch`, never leaks past `runEffects`.
 *  Exported so an `EntityApplier` can raise the same retry for its own non-version conflict (see
 *  `diplomat/db/repos/bills.ts`'s `billApplier`). */
export class VersionConflict extends Error {}

const resolveApplier = (registry: ApplierRegistry, entity: string): EntityApplier => {
  const applier = registry[entity];
  if (!applier) throw new Error(`runEffects: no applier registered for entity "${entity}"`);
  return applier;
};

const applyPersistable = async (tx: Tx, registry: ApplierRegistry, p: Persistable): Promise<PersistOutcome> => {
  const applier = resolveApplier(registry, p.entity);
  const outcome = await (async (): Promise<ApplierOutcome> => {
    switch (p.op) {
      case PersistOp.enum.insert:
        // An idempotent-duplicate no-op reports `applied: false` — inserts never retry here; the
        // duplicate treatment itself is the engine's, declared per entity (`idempotencyColumn`).
        return applier.insert(tx, p.model);
      case PersistOp.enum.update: {
        const updateOutcome = await applier.update(tx, p.model);
        if (!updateOutcome.applied) throw new VersionConflict();
        return updateOutcome;
      }
      case PersistOp.enum.delete: {
        const deleteOutcome = await applier.delete(tx, p.id, p.version);
        if (!deleteOutcome.applied) throw new VersionConflict();
        return deleteOutcome;
      }
      default: {
        const _exhaustive: never = p;
        throw new Error(`runEffects: unhandled persistable op ${JSON.stringify(_exhaustive)}`);
      }
    }
  })();
  return { ...outcome, entity: p.entity };
};

/** Applies the whole batch in one transaction, returning each outcome positionally parallel to
 *  `persist` — empty on a version conflict, since the transaction already rolled back. An empty
 *  batch (a dry-run preview flow) skips `db.transaction` entirely. */
const applyBatch = async (
  db: Db,
  registry: ApplierRegistry,
  persist: Persistable[],
): Promise<{ applied: boolean; outcomes: PersistOutcome[] }> => {
  if (persist.length === 0) return { applied: true, outcomes: [] };

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

/** Resolves `FlowOutcome.response` against the batch's outcomes — the plain value for the common
 *  case, or the result of calling the function an idempotency-aware flow handed back (rule 6). */
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
 * The generic effect runner (docs/functional-core-imperative-shell.md): runs `flow`, applies the
 * `persist` batch it returns in one `db.transaction` by dispatching each `Persistable` to the
 * `registry`'s applier for its entity, and returns `flow`'s `response`. Entity-agnostic — only the
 * `registry` (built once at the composition root) knows which entity is which. A version conflict
 * rolls back the whole batch and re-invokes `flow`, up to `MAX_RUN_EFFECTS_ATTEMPTS` times, before
 * surfacing the generic `conflict` error. This is the single-atomic-unit mode — the "unit of
 * work" mode.
 */
export const runEffects = <T>(db: Db, registry: ApplierRegistry, flow: Flow<T>): ResultAsync<T, AppError> =>
  attempt(db, registry, flow, MAX_RUN_EFFECTS_ATTEMPTS);

/** One unit's outcome from `runEffectsSequence`: its response, or the `AppError` it failed with
 *  (a domain error from its own flow, or a bounded-retry-exhausted `conflict`). A plain neverthrow
 *  `Result` — the caller narrows via `isOk`/`isErr` to shape a partial-success response, no
 *  bespoke tagged union or casting needed. */
export type SequenceOutcome<T> = Result<T, AppError>;

/**
 * The sequence-of-independent-units mode (ADR-022 decisions 3–4): applies `items` in order, each
 * through its own call to `attempt` — its own transaction, its own bounded conflict retry — so
 * retry semantics are identical to the single-atomic-unit mode by construction, never
 * re-implemented here. `flowFor(item)` is invoked only once this loop reaches that item, i.e.
 * after every earlier item has already committed (or been recorded as failed) — the re-invocation
 * this relies on for retry is the same mechanism that makes unit *i+1* see unit *i*'s committed
 * writes (option B). A unit's domain error, or its own retry exhaustion, is recorded as `Err` and
 * the loop continues to the next item — partial success, never a short-circuit; only a genuine
 * unexpected failure (not a version conflict) still throws, same as `runEffects`.
 */
export const runEffectsSequence = async <I, T>(
  db: Db,
  registry: ApplierRegistry,
  items: readonly I[],
  flowFor: (item: I) => Flow<T>,
): Promise<SequenceOutcome<T>[]> => {
  const outcomes: SequenceOutcome<T>[] = [];
  for (const item of items) {
    outcomes.push(await attempt(db, registry, flowFor(item), MAX_RUN_EFFECTS_ATTEMPTS));
  }
  return outcomes;
};
