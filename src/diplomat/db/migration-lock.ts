import type { Client } from '@libsql/client';
import { openLockFile, rollbackQuietly, tryBeginExclusive } from './file-lock.js';

const LOCK_SUFFIX = '.migrate.lock';
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 60_000;

export const lockPath = (dbFile: string): string => `${dbFile}${LOCK_SUFFIX}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const acquireExclusive = async (client: Client, path: string, deadline: number): Promise<void> => {
  for (;;) {
    const attempt = await tryBeginExclusive(client);
    if (attempt.acquired) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `fintrack: another FinTrack process has held the migration lock (${path}) for over ` +
          `${WAIT_LIMIT_MS / 1000}s. Stop it and retry.`,
        { cause: attempt.cause },
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
};

export const withMigrationLock = async <T>(dbFile: string, work: () => Promise<T>): Promise<T> => {
  const path = lockPath(dbFile);
  const client = await openLockFile(path);
  try {
    await acquireExclusive(client, path, Date.now() + WAIT_LIMIT_MS);
    try {
      return await work();
    } finally {
      await rollbackQuietly(client);
    }
  } finally {
    client.close();
  }
};
