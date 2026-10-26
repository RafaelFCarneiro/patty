import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
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

/** The database, its write-ahead log and its rollback journal: what a reader needs to see exactly what was committed —
 *  without a hot journal, pages of a transaction that never committed would read as if they had. */
const PROBE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;

/** Runs `look` on a private copy of the database files, which are removed afterwards. Opening the original would let
 *  SQLite recover or checkpoint a write-ahead log left by an unclean shutdown on close — a write to a file the probe
 *  must leave exactly as it found it — and libSQL has no read-only open. */
const onCopyOf = async <T>(databasePath: string, look: (copyPath: string) => Promise<T>): Promise<T> => {
  const directory = mkdtempSync(join(tmpdir(), 'fintrack-probe-'));
  try {
    PROBE_FILE_SUFFIXES.forEach((suffix) => {
      if (existsSync(`${databasePath}${suffix}`)) {
        copyFileSync(`${databasePath}${suffix}`, join(directory, `probe.db${suffix}`));
      }
    });
    return await look(join(directory, 'probe.db'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const lookAtOpenable = async (path: string): Promise<DatabaseLook> => {
  const db = await openDatabaseWithKey({ DB_PATH: path }, DEMO_DB_KEY, { initializeJournal: false });
  try {
    const repo = instanceRepo(db);
    return { probe: await repo.kind(), holdsData: await repo.hasUserData() };
  } finally {
    closeDatabase(db);
  }
};

/** What the file at `databasePath` says it is and whether it holds finances, from opening a private copy with the demo
 *  key: the original is never opened, so it is never written (no journal change, no checkpoint, no migration). A file
 *  that does not open that way (another key, not a database, a schema without the marker) is not a demo. */
export const probeDatabase = async (databasePath: string): Promise<DatabaseLook> => {
  if (!existsSync(databasePath)) return MISSING;
  try {
    return await onCopyOf(databasePath, lookAtOpenable);
  } catch {
    return UNREADABLE;
  }
};

const LOCK_SUFFIX = '.lock';
const SQLITE_BUSY_CODES = ['SQLITE_BUSY', 'SQLITE_LOCKED'];

const isBusy = (cause: unknown): boolean => {
  const code = (cause as { code?: string }).code ?? '';
  return SQLITE_BUSY_CODES.some((busy) => code.startsWith(busy));
};

export type DatabaseLock = { release: () => Promise<void> };

/**
 * Exclusive ownership of a database's preparation across processes: an exclusive SQLite transaction held on a small
 * `<db>.lock` database. The operating system owns the lock, so there is nothing to go stale — a process that dies,
 * however it dies, releases it — and nothing to reclaim or race over. Null when another run holds it. Held from
 * the first look at the file through seeding and cleanup, so two first runs cannot both believe they created it. The
 * lock file itself is never deleted: removing it while others wait would give them different files to lock.
 */
export const acquireDatabaseLock = async (databasePath: string): Promise<DatabaseLock | null> => {
  const lockPath = `${databasePath}${LOCK_SUFFIX}`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const client = createClient({ url: pathToFileURL(lockPath).href });
  try {
    await client.execute('PRAGMA busy_timeout = 0');
    await client.execute('BEGIN EXCLUSIVE');
    return {
      release: async () => {
        await client.execute('ROLLBACK');
        client.close();
      },
    };
  } catch (cause) {
    client.close();
    if (isBusy(cause)) return null;
    throw cause;
  }
};
