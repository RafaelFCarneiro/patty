import type { Client, Transaction } from '@libsql/client';
import type { SqlReader } from './tenancyIntegrity.js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { assertBusyTimeout, type Db } from './driver.js';
import { isSqliteBusy } from './sqliteErrors.js';

export const MIGRATIONS_TABLE = '__drizzle_migrations';

type MigrationRow = { created_at: number | string | null };

type Migration = ReturnType<typeof readMigrationFiles>[number];

const lastApplied = async (barrier: Transaction): Promise<MigrationRow | undefined> => {
  const [last] = (await barrier.execute(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`))
    .rows as unknown as MigrationRow[];
  return last;
};

const applyMigration = async (barrier: Transaction, migration: Migration): Promise<void> => {
  for (const statement of migration.sql) await barrier.execute(statement);
  await barrier.execute({
    sql: `INSERT INTO ${MIGRATIONS_TABLE} ("hash", "created_at") VALUES (?, ?)`,
    args: [migration.hash, migration.folderMillis],
  });
};

const applyPending = async (
  barrier: Transaction,
  migrations: readonly Migration[],
  last: MigrationRow | undefined,
): Promise<void> => {
  for (const migration of migrations) {
    const isPending = last === undefined || Number(last.created_at) < migration.folderMillis;
    if (isPending) await applyMigration(barrier, migration);
  }
};

export const applyPendingMigrationsHolding = async (
  db: Db,
  migrationsFolder: string,
  whileHeld: () => Promise<void>,
  verify: (migrated: SqlReader) => Promise<void> = async () => undefined,
): Promise<void> => {
  const { $client: client } = db as Db & { $client: Client };
  const migrations = readMigrationFiles({ migrationsFolder });

  await client.execute('PRAGMA foreign_keys=off');
  const barrier = await openWriteBarrier(client);
  try {
    const last = await lastApplied(barrier);
    await whileHeld();
    await applyPending(barrier, migrations, last);
    await verify(barrier);
    await barrier.commit();
  } catch (cause) {
    await barrier.rollback().catch(() => undefined);
    throw cause;
  } finally {
    barrier.close();
    await assertBusyTimeout(client);
  }
};

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
