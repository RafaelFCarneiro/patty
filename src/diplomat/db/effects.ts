import { and, eq, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as R from 'remeda';
import {
  VersionConflict,
  type ApplierRegistry as EngineApplierRegistry,
  type EntityApplier as EngineEntityApplier,
  type ReadBack as EngineReadBack,
} from '@rfc0/effect-runner';
import type { Tx } from './driver.js';
import { isForeignKeyConstraintViolation } from './sqliteErrors.js';

// Re-exported (not just imported) since the appliers below throw it directly.
export { VersionConflict };

// Re-exported so every existing `import type { Tx } from '../effects.js'` call site keeps
// resolving — `driver.ts` (the SQLite adapter, ADR-030) is now the sole place that derives it
// from `Db`.
export type { Tx };

// Tx-defaulted so every SQLite-backed registration below keeps typing itself without repeating it.
export type EntityApplier<TTx = Tx> = EngineEntityApplier<TTx>;
export type ApplierRegistry<TTx = Tx> = EngineApplierRegistry<TTx>;
export type ReadBack<TTx = Tx> = EngineReadBack<TTx>;

/** The fixed dedup column every idempotency-keyed insert writes to (ADR-029 Phase 2b) — never a
 *  per-registration name. Not every `VersionedTable` has it; `keyColumn` below is `undefined` for
 *  one that doesn't. */
const IDEMPOTENCY_KEY_COLUMN = 'idempotencyKey';

/** An `id` + `version` column shape, matching most mutable tables — a table outside the
 *  convention (the link/key-only tables carry no `id`/`version` at all) hand-writes its own
 *  `EntityApplier` instead. */
type VersionedTable = SQLiteTable & { id: AnySQLiteColumn; version: AnySQLiteColumn };

/** A versioned table that carries its owner (ADR-033 §5). */
type OwnedTable = VersionedTable & { userId: AnySQLiteColumn };

type VersionedTableConfig = {
  readBack?: ReadBack;
};

/** Everything an applier does for a user (ADR-033 §5): `insert` stamps the row with `userId`; `update` and `delete` add
 *  `AND user_id = :me` to their predicate, so another user's row — and a shared default, whose `user_id` is NULL —
 *  never matches and the write fails exactly like a stale version (`VersionConflict`, then the engine's retry and
 *  `conflict`). The row a flow hands an applier never carries `userId`: a flow cannot choose an owner, and an update
 *  cannot change it. */
type OwnerScope = { userId: string };

/**
 * Builds an `EntityApplier` for any table following the `id`/`version` convention. Two mechanics
 * worth knowing: `insert`'s `onConflictDoNothing` is scoped to a single conflict target (the fixed
 * `idempotencyKey` column when the row carries a key AND the table has that column, else `id`), so
 * a genuine violation of any other unique column (e.g. `tags.name`) still surfaces as a real error
 * instead of being swallowed as a same-id retry; and the next `version` is computed here in
 * application code from the row's own field, never a SQL-side `version + 1` the database evaluates
 * on its own.
 */
export const missingIdempotencyKeyMessage = (): string =>
  `runEffects: table has an "${IDEMPOTENCY_KEY_COLUMN}" column but the insert carries no idempotencyKey`;

export const unexpectedIdempotencyKeyMessage = (): string =>
  `runEffects: insert carries an idempotencyKey but its table has no "${IDEMPOTENCY_KEY_COLUMN}" column`;

const applierFor = <T extends VersionedTable>(
  table: T,
  owner: OwnerScope | undefined,
  config: VersionedTableConfig,
): EntityApplier => {
  const { readBack } = config;
  const columns = table as unknown as Record<string, AnySQLiteColumn | undefined>;
  const keyColumn = columns[IDEMPOTENCY_KEY_COLUMN];
  const ownerColumn = owner ? columns['userId'] : undefined;
  if (owner && !ownerColumn) throw new Error('versionedTableApplier: an owner scope needs a "userId" column');

  /** The predicate every write adds for a scoped applier — nothing, for a table that is not owned. */
  const ownedBy = (): SQL[] => (owner && ownerColumn ? [eq(ownerColumn, owner.userId)] : []);

  // The engine's one idempotency read: which row already holds the key a just-conflicted insert
  // carried. Runs inside the same transaction as the no-op'd insert, so absence is an invariant
  // violation, not an expected miss. Scoped to the owner: a key is unique per user, not globally.
  const findSurvivingRowId = async (tx: Tx, column: AnySQLiteColumn, key: string): Promise<string> => {
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(column, key), ...ownedBy()));
    if (!row) throw new Error(`runEffects: no surviving row holds idempotency key "${key}" after a duplicate insert`);
    return row.id as string;
  };

  return {
    insert: async (tx, model, idempotencyKey) => {
      // Reject either mismatch loudly here, rather than let a missing key reach the database as an
      // opaque NOT NULL violation, or a set key silently no-op with no dedup at all.
      if (keyColumn && idempotencyKey === undefined) {
        throw new Error(missingIdempotencyKeyMessage());
      }
      if (!keyColumn && idempotencyKey !== undefined) {
        throw new Error(unexpectedIdempotencyKeyMessage());
      }
      const given = model as Record<string, unknown> & { id: string };
      // A scoped applier never takes the owner from the flow: whatever it carried, the row is the applier's user's.
      const row = owner ? R.omit(given, ['userId']) : given;
      const stamped = owner ? { ...row, userId: owner.userId } : row;
      const rowToInsert =
        keyColumn && idempotencyKey !== undefined ? { ...stamped, [IDEMPOTENCY_KEY_COLUMN]: idempotencyKey } : stamped;
      // The key is unique per user (`UNIQUE(user_id, idempotency_key)`), so the conflict target names both columns.
      const keyTarget = ownerColumn && keyColumn ? [ownerColumn, keyColumn] : keyColumn;
      const result = await tx
        .insert(table)
        .values(rowToInsert as never)
        .onConflictDoNothing({ target: idempotencyKey !== undefined && keyTarget ? keyTarget : table.id });
      const applied = (result.rowsAffected ?? 0) > 0;
      if (!readBack) return { applied };

      // On an idempotent duplicate the persisted row is the one already holding the key — the
      // minted `row.id` was never inserted, so the projection must read the survivor instead.
      const persistedId =
        applied || idempotencyKey === undefined || !keyColumn
          ? row.id
          : await findSurvivingRowId(tx, keyColumn, idempotencyKey);
      return { applied, read: await readBack(tx, persistedId) };
    },

    update: async (tx, model) => {
      const row = model as Record<string, unknown> & { id: string; version: number };
      // A scoped applier never lets an update move a row to another owner.
      const values = R.omit(row, owner ? ['id', 'version', 'userId'] : ['id', 'version']);
      const result = await tx
        .update(table)
        .set({ ...values, version: row.version + 1 } as never)
        .where(and(eq(table.id, row.id), eq(table.version, row.version), ...ownedBy()));
      const applied = (result.rowsAffected ?? 0) > 0;
      if (!applied || !readBack) return { applied };
      return { applied, read: await readBack(tx, row.id) };
    },

    delete: async (tx, id, version) => {
      try {
        const result = await tx.delete(table).where(and(eq(table.id, id), eq(table.version, version), ...ownedBy()));
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

/** For a table nobody owns (the shared reference tables). */
export const versionedTableApplier = <T extends VersionedTable>(
  table: T,
  config: VersionedTableConfig = {},
): EntityApplier => applierFor(table, undefined, config);

/** For a table whose rows belong to a user (ADR-033 §5): the applier of one user, built per request. */
export const ownedTableApplier = <T extends OwnedTable>(
  table: T,
  userId: string,
  config: VersionedTableConfig = {},
): EntityApplier => applierFor(table, { userId }, config);
