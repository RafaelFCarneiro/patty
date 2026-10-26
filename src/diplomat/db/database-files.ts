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

const realPathOfMissing = (path: string): string | null => {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  if (isSymlink(absolute)) return null;
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  const resolvedParent = realPathOfMissing(parent);
  return resolvedParent === null ? null : join(resolvedParent, basename(absolute));
};

/** Null when the path cannot be resolved (a link loop, a chain of dangling links). */
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

/** Includes the hot rollback journal: without it, a crashed transaction's pages would read as committed. */
const PROBE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;

/** libSQL has no read-only open and closing can checkpoint a log: probe a copy, never the original. */
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

/** Held by the OS, so a dead process releases it; the lock file is never deleted, or waiters would lock another. */
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
