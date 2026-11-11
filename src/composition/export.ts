import { existsSync, rmSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { loadCredentialsModule } from './auth.js';
import { loadConfig } from '../config.js';
import type { Exporter } from '../diplomat/cli/io.js';
import { closeDatabase, openDatabaseWithKey, resolveEncryptionKey, type Db } from '../diplomat/db/driver.js';
import { countSnapshotRows } from '../diplomat/db/export.js';
import { usersRepo } from '../diplomat/db/repos/users.js';
import { snapshotTo } from '../diplomat/db/safety-copy.js';
import { reasonOf } from '../models/error.js';
import type { UserEntity } from '../models/auth/owner.js';
import { FILE_EXISTS_CODE, type ExportedRowCounts } from '../models/export.js';

type KeyedDatabase = { key: string; db: Db };

const missingDatabase = (file: string): string => `there is no database at ${file}`;

/** The database opened with its key and read once: a wrong key fails on that first read, never on a later write.
 *  A missing file fails before the key is resolved, so a keychain with no entry is not given a key for nothing. */
const openKeyed = async (): Promise<Result<KeyedDatabase, string>> => {
  const config = loadConfig();
  if (!existsSync(config.DB_PATH)) return err(missingDatabase(config.DB_PATH));
  try {
    const key = await resolveEncryptionKey(config);
    const db = await openDatabaseWithKey(config, key);
    try {
      await db.run(sql`SELECT count(*) FROM sqlite_master`);
    } catch (cause) {
      closeDatabase(db);
      throw cause;
    }
    return ok({ key, db });
  } catch (cause) {
    return err(reasonOf(cause));
  }
};

/** Nothing is left behind by a snapshot that failed — except a file that was there before we asked (`wx` refused it),
 *  which is not ours to remove. */
const snapshotAndCount = async ({ key, db }: KeyedDatabase, destination: string): Promise<ExportedRowCounts> => {
  try {
    await snapshotTo(db, destination);
    return await countSnapshotRows(destination, key);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== FILE_EXISTS_CODE) rmSync(destination, { force: true });
    throw cause;
  }
};

/** Reads the users of the database as it is — no migration, so a database a newer build has not migrated yet fails
 *  here (a missing column) and the person is told to start the server once, not upgraded behind their back. */
const readUsers = async (): Promise<Result<UserEntity[], string>> => {
  const opened = await openKeyed();
  if (opened.isErr()) return err(opened.error);
  try {
    return ok(await usersRepo(opened.value.db).listAll());
  } catch (cause) {
    return err(reasonOf(cause));
  } finally {
    closeDatabase(opened.value.db);
  }
};

export const createExporter = (): Exporter => ({
  databasePath: () => loadConfig().DB_PATH,
  provenKey: async () => {
    const opened = await openKeyed();
    if (opened.isErr()) return err(opened.error);
    closeDatabase(opened.value.db);
    return ok(opened.value.key);
  },
  users: readUsers,
  stepUpSecrets: async () => (await loadCredentialsModule()).createSecrets(),
  writeSnapshot: async (destination) => {
    const opened = await openKeyed();
    if (opened.isErr()) return err(opened.error);
    try {
      return ok(await snapshotAndCount(opened.value, destination));
    } catch (cause) {
      return err(reasonOf(cause));
    } finally {
      closeDatabase(opened.value.db);
    }
  },
});
