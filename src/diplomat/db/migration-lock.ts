import { withExclusiveLock } from './file-lock.js';

const LOCK_SUFFIX = '.migrate.lock';
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 60_000;

export const lockPath = (dbFile: string): string => `${dbFile}${LOCK_SUFFIX}`;

export const withMigrationLock = <T>(dbFile: string, work: () => Promise<T>): Promise<T> => {
  const path = lockPath(dbFile);
  return withExclusiveLock(
    path,
    {
      waitMs: WAIT_LIMIT_MS,
      retryMs: POLL_INTERVAL_MS,
      timeoutMessage:
        `fintrack: another FinTrack process has held the migration lock (${path}) for over ` +
        `${WAIT_LIMIT_MS / 1000}s. Stop it and retry.`,
    },
    work,
  );
};
