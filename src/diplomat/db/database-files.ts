import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { link, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEMO_DB_KEY, DemoProbeAbsence, type DemoDatabaseLook } from '../../models/demo/core.js';
import {
  DATABASE_COMPANION_SUFFIXES,
  EXCLUSIVE_CREATE_FLAG,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  type ExportedRowCounts,
} from '../../models/export.js';
import { closeDatabase, openDatabaseWithKey } from './driver.js';
import { countSnapshotRows } from './export.js';
import { tryExclusiveLock, type ExclusiveLock } from './file-lock.js';
import { instanceRepo } from './repos/instance.js';

const DATABASE_FILE_SUFFIXES = ['', ...DATABASE_COMPANION_SUFFIXES] as const;

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

const MISSING: DemoDatabaseLook = { probe: DemoProbeAbsence.enum.missing, holdsData: false };
const UNREADABLE: DemoDatabaseLook = { probe: DemoProbeAbsence.enum.unreadable, holdsData: false };

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

/** Proves `key` opens the database at `databasePath` and counts its rows, on a private copy: nothing at
 *  `databasePath` is opened, checkpointed or written. Rejects when the key is wrong or the file is no database. */
export const countRowsOnCopy = (databasePath: string, key: string): Promise<ExportedRowCounts> =>
  onCopyOf(databasePath, (copyPath) => countSnapshotRows(copyPath, key));

const lookAtOpenable = async (path: string): Promise<DemoDatabaseLook> => {
  const db = await openDatabaseWithKey({ DB_PATH: path }, DEMO_DB_KEY, { initializeJournal: false });
  try {
    const repo = instanceRepo(db);
    return { probe: await repo.kind(), holdsData: await repo.hasUserData() };
  } finally {
    closeDatabase(db);
  }
};

export const probeDatabase = async (databasePath: string): Promise<DemoDatabaseLook> => {
  if (!existsSync(databasePath)) return MISSING;
  try {
    return await onCopyOf(databasePath, lookAtOpenable);
  } catch {
    return UNREADABLE;
  }
};

const IMPORT_STAGING_INFIX = '.import-';

/** Copies `from` into a staging file only this call can have created (`wx`, a name no other call draws). */
const copyToStaging = async (from: string, staging: string): Promise<void> => {
  const destination = await open(staging, EXCLUSIVE_CREATE_FLAG, PRIVATE_FILE_MODE);
  await pipeline(createReadStream(from), destination.createWriteStream());
};

/** Copies `from` to a new owner-only file at `to`, creating the data directory. The copy is staged beside `to` and
 *  published with a hard link, which is atomic and refuses a `to` that exists (a dangling link included): `to` is
 *  never visible empty or half-written, never replaced, and an interrupted or failed copy leaves nothing at it. The
 *  staging file is this call's own and is always removed. */
export const copyNewPrivateFile = async (from: string, to: string): Promise<void> => {
  mkdirSync(dirname(to), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const staging = `${to}${IMPORT_STAGING_INFIX}${randomUUID()}`;
  try {
    await copyToStaging(from, staging);
    await link(staging, to);
  } finally {
    rmSync(staging, { force: true });
  }
};

const LOCK_SUFFIX = '.lock';

/** Held by the OS, so a dead process releases it; the lock file is never deleted, or waiters would lock another. */
export const acquireDatabaseLock = (databasePath: string): Promise<ExclusiveLock | null> => {
  const lockPath = `${databasePath}${LOCK_SUFFIX}`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return tryExclusiveLock(lockPath);
};
