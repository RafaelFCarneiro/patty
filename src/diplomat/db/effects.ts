import { and, eq } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as R from 'remeda';
import {
  VersionConflict,
  type ApplierRegistry as EngineApplierRegistry,
  type EntityApplier as EngineEntityApplier,
  type ReadBack as EngineReadBack,
} from '@rafaelfcarneiro/effect-runner';
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

type VersionedTableConfig = {
  readBack?: ReadBack;
};

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

export const versionedTableApplier = <T extends VersionedTable>(
  table: T,
  config: VersionedTableConfig = {},
): EntityApplier => {
  const { readBack } = config;
  const keyColumn = (table as unknown as Record<string, AnySQLiteColumn | undefined>)[IDEMPOTENCY_KEY_COLUMN];

  // The engine's one idempotency read: which row already holds the key a just-conflicted insert
  // carried. Runs inside the same transaction as the no-op'd insert, so absence is an invariant
  // violation, not an expected miss.
  const findSurvivingRowId = async (tx: Tx, column: AnySQLiteColumn, key: string): Promise<string> => {
    const [row] = await tx.select({ id: table.id }).from(table).where(eq(column, key));
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
      const row = model as Record<string, unknown> & { id: string };
      const rowToInsert =
        keyColumn && idempotencyKey !== undefined ? { ...row, [IDEMPOTENCY_KEY_COLUMN]: idempotencyKey } : row;
      const result = await tx
        .insert(table)
        .values(rowToInsert as never)
        .onConflictDoNothing({ target: idempotencyKey !== undefined && keyColumn ? keyColumn : table.id });
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
