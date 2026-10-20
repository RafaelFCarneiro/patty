import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { isSqliteBusy } from './sqliteErrors.js';

const LOCK_SUFFIX = '.migrate.lock';
const POLL_INTERVAL_MS = 100;
const WAIT_LIMIT_MS = 60_000;

/** Where the cross-process migration lock for `dbFile` lives — next to it, like the WAL and the backups. */
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

/**
 * Runs `work` while holding an exclusive, cross-process lock on `dbFile`'s migration (ADR-024: several stdio
 * servers may start against one file at once). Without it two starters could both see a data-rewriting
 * migration pending, each take a "pre-migration" copy, and one copy the other's already-migrated file over
 * the good backup.
 *
 * The lock is SQLite's own: an `EXCLUSIVE` transaction on a small companion database next to the data file.
 * The OS owns it, so it is atomic, there is no stale-lock cleanup to race over (a crashed holder's lock simply
 * vanishes with its process), and nobody ever unlinks a lock another process holds. A waiter polls rather than
 * blocking in `busy_timeout`, which would freeze its event loop — and, in-process, the holder's. Whoever waits
 * re-evaluates "is it still pending?" once it holds the lock. The companion file is left in place on purpose:
 * removing it while others wait would let a newcomer lock a different inode.
 */
export const withMigrationLock = async <T>(dbFile: string, work: () => Promise<T>): Promise<T> => {
  const path = lockPath(dbFile);
  const client = createClient({ url: pathToFileURL(path).href });
  try {
    // Never block inside SQLite: a synchronous wait would freeze this event loop (and, in-process, the holder's).
    await client.execute('PRAGMA busy_timeout = 0');
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
