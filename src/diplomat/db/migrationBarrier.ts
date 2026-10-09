import type { Client } from '@libsql/client';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { assertBusyTimeout, type Db } from './driver.js';
import { isSqliteBusy } from './sqliteErrors.js';

/** drizzle's own bookkeeping table — this runner must keep it exactly as drizzle's migrator does, so the regular
 *  `migrate()` that follows finds nothing left to apply. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

type MigrationRow = { created_at: number | string | null };

/**
 * Applies every pending migration inside ONE SQLite write transaction (`BEGIN IMMEDIATE`) and runs `whileHeld`
 * after the write lock is taken and before anything changes. That lock is the barrier an ordinary writer — even
 * an already-running process on an older release, which no FinTrack-level lock can reach — cannot cross: it gets
 * `SQLITE_BUSY` until we commit. Reads stay open under WAL, so `whileHeld` can snapshot the database through
 * another connection and the snapshot is exactly the state the migrations then start from: nothing can commit
 * between the two, and nothing can be lost from the backup.
 *
 * It mirrors `drizzle-orm/libsql`'s `migrate()` (foreign keys off, the same statements, the same
 * `__drizzle_migrations` rows), only with the lock taken first and held across `whileHeld`.
 */
export const applyPendingMigrationsHolding = async (
  db: Db,
  migrationsFolder: string,
  whileHeld: () => Promise<void>,
): Promise<void> => {
  // drizzle's libsql driver exposes the client it wraps at runtime; its type declaration does not.
  const { $client: client } = db as Db & { $client: Client };
  const migrations = readMigrationFiles({ migrationsFolder });

  // On the connection that is about to become the transaction, as libsql's own migrator does. (libsql's
  // `close()` on a transaction only rolls it back, leaving the native handle to the GC — true of every
  // transaction in this app — so that connection's `foreign_keys=off` dies with it, never reaching a query.)
  await client.execute('PRAGMA foreign_keys=off');
  const barrier = await openWriteBarrier(client);
  try {
    const [last] = (
      await barrier.execute(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`)
    ).rows as unknown as MigrationRow[];
    await whileHeld();

    for (const migration of migrations) {
      const isPending = last === undefined || Number(last.created_at) < migration.folderMillis;
      if (!isPending) continue;
      for (const statement of migration.sql) await barrier.execute(statement);
      await barrier.execute({
        sql: `INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`,
        args: [migration.hash, migration.folderMillis],
      });
    }
    await barrier.commit();
  } catch (cause) {
    // Roll back, but never let a rollback that itself fails (SQLite already rolled back on a full disk or an I/O
    // error, so libsql reports "transaction closed") hide the error that got us here.
    await barrier.rollback().catch(() => undefined);
    throw cause;
  } finally {
    barrier.close();
    // libsql swapped in a fresh connection when the transaction took the old one; it starts with no busy timeout.
    await assertBusyTimeout(client);
  }
};

// BEGIN IMMEDIATE waits out `busy_timeout` for another process's write transaction; if that is not enough, say so
// in terms an operator can act on instead of a bare `SQLITE_BUSY`.
const openWriteBarrier = async (client: Client) => {
  try {
    return await client.transaction('write');
  } catch (cause) {
    if (!isSqliteBusy(cause)) throw cause;
    throw new Error(
      'fintrack: cannot start the database upgrade — another FinTrack process is writing to the database. ' +
        'Stop it (or wait for it to finish) and start again.',
      { cause },
    );
  }
};
