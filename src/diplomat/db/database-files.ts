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

export const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The real path of the nearest ancestor that exists, with the missing components appended: a symlinked ancestor of a
 *  file that does not exist yet is resolved too. Null when an ancestor is a link that cannot be resolved (a loop). */
const realPathOfMissing = (path: string): string | null => {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  if (isSymlink(absolute)) return null;
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const resolvedParent = realPathOfMissing(parent);
  return resolvedParent === null ? null : join(resolvedParent, basename(absolute));
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

export type DatabaseLook = { probe: DemoProbe; holdsData: boolean };

const MISSING: DatabaseLook = { probe: DemoProbeAbsence.enum.missing, holdsData: false };
const UNREADABLE: DatabaseLook = { probe: DemoProbeAbsence.enum.unreadable, holdsData: false };

/** What the file at `databasePath` says it is and whether it holds finances, from opening it with the demo key —
 *  read-only in effect: no journal-mode change, no migration, no write. A file that does not open that way (another
 *  key, not a database, a schema without the marker) is not a demo. */
export const probeDatabase = async (databasePath: string): Promise<DatabaseLook> => {
  if (!existsSync(databasePath)) return MISSING;
  try {
    const db = await openDatabaseWithKey({ DB_PATH: databasePath }, DEMO_DB_KEY, { initializeJournal: false });
    try {
      const repo = instanceRepo(db);
      return { probe: await repo.kind(), holdsData: await repo.hasUserData() };
    } finally {
      closeDatabase(db);
    }
  } catch {
    return UNREADABLE;
  }
};
