import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

const LOCK_SUFFIX = '.migrate.lock';
const LOCK_FILE_MODE = 0o600;
const EXCLUSIVE_CREATE = 'wx';
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 60_000;

/** Where the cross-process migration lock for `dbFile` lives — next to it, like the WAL and the backups. */
export const lockPath = (dbFile: string): string => `${dbFile}${LOCK_SUFFIX}`;

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === code;

// A lock whose owner is gone (killed mid-migration) must not wedge every later start.
const isHeldByLiveProcess = (path: string): boolean => {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    if (!Number.isInteger(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // ESRCH: no such process. Unreadable/garbled lock: treat as abandoned. EPERM: alive, someone else's.
    return isErrno(cause, 'EPERM');
  }
};

const tryAcquire = (path: string): boolean => {
  try {
    const fd = openSync(path, EXCLUSIVE_CREATE, LOCK_FILE_MODE);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (cause) {
    if (isErrno(cause, 'EEXIST')) return false;
    throw cause;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` while holding an exclusive, cross-process lock on `dbFile`'s migration (ADR-024: several stdio
 * servers may start against one file at once). Without it two starters could both see a data-rewriting
 * migration pending, each take a "pre-migration" copy, and one copy the other's already-migrated file over
 * the good backup. The lock is a file created exclusively and holding the owner's pid; a lock whose owner
 * has died is broken. Whoever waits re-evaluates "is it still pending?" once it holds the lock.
 */
export const withMigrationLock = async <T>(dbFile: string, work: () => Promise<T>): Promise<T> => {
  const path = lockPath(dbFile);
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!tryAcquire(path)) {
    if (!isHeldByLiveProcess(path)) {
      unlinkSync(path);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `fintrack: another FinTrack process has held the migration lock (${path}) for over ${WAIT_LIMIT_MS / 1000}s. ` +
          'Stop it, or delete the lock file if you are sure no other FinTrack is running.',
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  try {
    return await work();
  } finally {
    unlinkSync(path);
  }
};
