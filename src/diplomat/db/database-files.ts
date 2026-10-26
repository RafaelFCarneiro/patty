import { existsSync, lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEMO_DB_KEY, DemoProbeAbsence, type DemoProbe } from '../../models/demo.js';
import { closeDatabase, openDatabaseWithKey } from './driver.js';
import { instanceRepo } from './repos/instance.js';

/** The files SQLite keeps beside a database: its journal in WAL mode, its shared memory, a rollback journal. */
const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export const databaseExists = (databasePath: string): boolean => existsSync(databasePath);

export const removeDatabaseFiles = (databasePath: string): void =>
  DATABASE_FILE_SUFFIXES.forEach((suffix) => rmSync(`${databasePath}${suffix}`, { force: true }));

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** A path that does not exist (yet): its existing directory's real path plus its name. */
const realPathOfMissing = (path: string): string => {
  const directory = dirname(resolve(path));
  return existsSync(directory) ? join(realpathSync(directory), basename(path)) : resolve(path);
};

/**
 * The one real spelling of a path, so two paths to the same file compare equal: `realpathSync` for one that exists,
 * and for a path that is a dangling symlink, the file it points at (one hop). Null when it cannot be resolved — a
 * link loop, or a link to another dangling link — which the caller treats as "cannot be shown to be anything else".
 */
export const canonicalPath = (path: string): string | null => {
  if (existsSync(path)) return realpathSync(path);
  if (!isSymlink(path)) return realPathOfMissing(path);
  const target = resolve(dirname(path), readlinkSync(path));
  if (existsSync(target)) return realpathSync(target);
  return isSymlink(target) ? null : realPathOfMissing(target);
};

/** What the file at `databasePath` says it is, from opening it with the demo key — nothing is migrated or written. A
 *  file that does not open that way (another key, not a database, a schema without the marker) is not a demo. */
export const probeDatabase = async (databasePath: string): Promise<DemoProbe> => {
  if (!existsSync(databasePath)) return DemoProbeAbsence.enum.missing;
  try {
    const db = await openDatabaseWithKey({ DB_PATH: databasePath }, DEMO_DB_KEY);
    try {
      return await instanceRepo(db).kind();
    } finally {
      closeDatabase(db);
    }
  } catch {
    return DemoProbeAbsence.enum.unreadable;
  }
};
