import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { isSqliteBusy } from './sqlite-errors.js';

const LOCK_SUFFIX = '.migrate.lock';
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 60_000;
const NEVER_BLOCK_IN_SQLITE_MS = 0;

export const lockPath = (dbFile: string): string => `${dbFile}${LOCK_SUFFIX}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const acquireExclusive = async (client: Client, path: string, deadline: number): Promise<void> => {
  for (;;) {
    try {
      await client.execute('BEGIN EXCLUSIVE');
      return;
    } catch (cause) {
      if (!isSqliteBusy(cause)) throw cause;
      if (Date.now() >= deadline) {
        throw new Error(
          `fintrack: another FinTrack process has held the migration lock (${path}) for over ` +
            `${WAIT_LIMIT_MS / 1000}s. Stop it and retry.`,
          { cause },
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
};

export const withMigrationLock = async <T>(dbFile: string, work: () => Promise<T>): Promise<T> => {
  const path = lockPath(dbFile);
  const client = createClient({ url: pathToFileURL(path).href });
  try {
    await client.execute(`PRAGMA busy_timeout = ${NEVER_BLOCK_IN_SQLITE_MS}`);
    await acquireExclusive(client, path, Date.now() + WAIT_LIMIT_MS);
    try {
      return await work();
    } finally {
      await client.execute('ROLLBACK');
    }
  } finally {
    client.close();
  }
};
