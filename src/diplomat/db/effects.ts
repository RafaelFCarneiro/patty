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

type OwnedTable = VersionedTable & { userId: AnySQLiteColumn };

type VersionedTableConfig = {
  readBack?: ReadBack;
};

/**
 * Scoped appliers stamp user_id on insert and add `AND user_id = :me` to update/delete, so another user's row (or a
 * shared default, user_id NULL) never matches and fails like a stale version. A model's own userId is ignored.
 */
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

type TableContext = {
  table: VersionedTable;
  keyColumn: AnySQLiteColumn | undefined;
  ownerColumn: AnySQLiteColumn | undefined;
  ownedBy: () => SQL[];
  readBack: ReadBack | undefined;
  owner: OwnerScope | undefined;
};

type InsertedRow = Record<string, unknown> & { id: string };

const tableContextFor = (
  table: VersionedTable,
  owner: OwnerScope | undefined,
  readBack: ReadBack | undefined,
): TableContext => {
  const columns = table as unknown as Record<string, AnySQLiteColumn | undefined>;
  const ownerColumn = owner ? columns['userId'] : undefined;
  if (owner && !ownerColumn) throw new Error('versionedTableApplier: an owner scope needs a "userId" column');

  return {
    table,
    keyColumn: columns[IDEMPOTENCY_KEY_COLUMN],
    ownerColumn,
    ownedBy: (): SQL[] => (owner && ownerColumn ? [eq(ownerColumn, owner.userId)] : []),
    readBack,
    owner,
  };
};

// The engine's one idempotency read: which row already holds the key a just-conflicted insert
// carried. Runs inside the same transaction as the no-op'd insert, so absence is an invariant
// violation, not an expected miss. Scoped to the owner: a key is unique per user, not globally.
const findSurvivingRowId = async (
  { table, ownedBy }: TableContext,
  tx: Tx,
  column: AnySQLiteColumn,
  key: string,
): Promise<string> => {
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(column, key), ...ownedBy()));
  if (!row) throw new Error(`runEffects: no surviving row holds idempotency key "${key}" after a duplicate insert`);
  return row.id as string;
};

// Reject either mismatch loudly here, rather than let a missing key reach the database as an
// opaque NOT NULL violation, or a set key silently no-op with no dedup at all.
const assertKeyMatchesTable = ({ keyColumn }: TableContext, idempotencyKey: string | undefined): void => {
  if (keyColumn && idempotencyKey === undefined) {
    throw new Error(missingIdempotencyKeyMessage());
  }
  if (!keyColumn && idempotencyKey !== undefined) {
    throw new Error(unexpectedIdempotencyKeyMessage());
  }
};

const rowToInsert = (
  { owner, keyColumn }: TableContext,
  model: unknown,
  idempotencyKey: string | undefined,
): InsertedRow => {
  const given = model as InsertedRow;
  const row = owner ? R.omit(given, ['userId']) : given;
  const stamped = owner ? { ...row, userId: owner.userId } : row;
  return keyColumn && idempotencyKey !== undefined ? { ...stamped, [IDEMPOTENCY_KEY_COLUMN]: idempotencyKey } : stamped;
};

const conflictTarget = (
  { table, keyColumn, ownerColumn }: TableContext,
  idempotencyKey: string | undefined,
): AnySQLiteColumn | AnySQLiteColumn[] => {
  const keyTarget = ownerColumn && keyColumn ? [ownerColumn, keyColumn] : keyColumn;
  return idempotencyKey !== undefined && keyTarget ? keyTarget : table.id;
};

// On an idempotent duplicate the persisted row is the one already holding the key — the
// minted `row.id` was never inserted, so the projection must read the survivor instead.
const persistedIdAfter = async (
  ctx: TableContext,
  tx: Tx,
  applied: boolean,
  row: InsertedRow,
  idempotencyKey: string | undefined,
): Promise<string> =>
  applied || idempotencyKey === undefined || !ctx.keyColumn
    ? row.id
    : await findSurvivingRowId(ctx, tx, ctx.keyColumn, idempotencyKey);

const insertRow =
  (ctx: TableContext): EntityApplier['insert'] =>
  async (tx, model, idempotencyKey) => {
    assertKeyMatchesTable(ctx, idempotencyKey);
    const row = rowToInsert(ctx, model, idempotencyKey);
    const result = await tx
      .insert(ctx.table)
      .values(row as never)
      .onConflictDoNothing({ target: conflictTarget(ctx, idempotencyKey) });
    const applied = (result.rowsAffected ?? 0) > 0;
    if (!ctx.readBack) return { applied };
    return { applied, read: await ctx.readBack(tx, await persistedIdAfter(ctx, tx, applied, row, idempotencyKey)) };
  };

const updateRow =
  ({ table, owner, ownedBy, readBack }: TableContext): EntityApplier['update'] =>
  async (tx, model) => {
    const row = model as Record<string, unknown> & { id: string; version: number };
    const values = R.omit(row, owner ? ['id', 'version', 'userId'] : ['id', 'version']);
    const result = await tx
      .update(table)
      .set({ ...values, version: row.version + 1 } as never)
      .where(and(eq(table.id, row.id), eq(table.version, row.version), ...ownedBy()));
    const applied = (result.rowsAffected ?? 0) > 0;
    if (!applied || !readBack) return { applied };
    return { applied, read: await readBack(tx, row.id) };
  };

const deleteRow =
  ({ table, ownedBy }: TableContext): EntityApplier['delete'] =>
  async (tx, id, version) => {
    try {
      const result = await tx.delete(table).where(and(eq(table.id, id), eq(table.version, version), ...ownedBy()));
      return { applied: (result.rowsAffected ?? 0) > 0 };
    } catch (cause) {
      // A row referencing this one was inserted after the flow's read — the same "world changed"
      // condition a stale version reports, just surfaced by the FK check instead.
      if (isForeignKeyConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  };

// Read-only: is the row still at the version the flow read? SQLite takes the write lock when the transaction
// begins, so no other writer can move the row before commit and a plain read holds the guarantee.
const checkRow =
  ({ table, ownedBy }: TableContext): EntityApplier['check'] =>
  async (tx, id, version) => {
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.version, version), ...ownedBy()))
      .limit(1);
    return { applied: row !== undefined };
  };

const applierFor = (
  table: VersionedTable,
  owner: OwnerScope | undefined,
  { readBack }: VersionedTableConfig,
): EntityApplier => {
  const ctx = tableContextFor(table, owner, readBack);
  return { insert: insertRow(ctx), update: updateRow(ctx), delete: deleteRow(ctx), check: checkRow(ctx) };
};

export const versionedTableApplier = <T extends VersionedTable>(
  table: T,
  config: VersionedTableConfig = {},
): EntityApplier => applierFor(table, undefined, config);

export const ownedTableApplier = <T extends OwnedTable>(
  table: T,
  userId: string,
  config: VersionedTableConfig = {},
): EntityApplier => applierFor(table, { userId }, config);
