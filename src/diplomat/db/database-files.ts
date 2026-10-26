import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const LOCK_SUFFIX = '.lock';
const FILE_EXISTS = 'EEXIST';
const NO_SUCH_PROCESS = 'ESRCH';

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== NO_SUCH_PROCESS;
  }
};

const tryCreateLock = (lockPath: string): boolean => {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === FILE_EXISTS) return false;
    throw cause;
  }
};

const isHeldByLiveProcess = (lockPath: string): boolean => {
  try {
    return isProcessAlive(Number(readFileSync(lockPath, 'utf8')));
  } catch {
    return false;
  }
};

export type DatabaseLock = { release: () => void };

/**
 * Exclusive ownership of a database's preparation across processes: a `<db>.lock` file created exclusively and holding
 * the owner's pid. Null when another live process holds it; a lock left by a process that is gone is taken over. Held
 * from the first look at the file through seeding and cleanup, so two first runs cannot both believe they created it.
 */
export const acquireDatabaseLock = (databasePath: string): DatabaseLock | null => {
  const lockPath = `${databasePath}${LOCK_SUFFIX}`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const owned =
    tryCreateLock(lockPath) ||
    (!isHeldByLiveProcess(lockPath) && (rmSync(lockPath, { force: true }), tryCreateLock(lockPath)));
  return owned ? { release: () => rmSync(lockPath, { force: true }) } : null;
};
