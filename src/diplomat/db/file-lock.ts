import { pathToFileURL } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { isSqliteBusy } from './sqlite-errors.js';

export const NEVER_BLOCK_IN_SQLITE_MS = 0;

export type ExclusiveLock = { release: () => Promise<void> };

export const openLockFile = async (lockPath: string): Promise<Client> => {
  const client = createClient({ url: pathToFileURL(lockPath).href });
  try {
    await client.execute(`PRAGMA busy_timeout = ${NEVER_BLOCK_IN_SQLITE_MS}`);
    return client;
  } catch (cause) {
    client.close();
    throw cause;
  }
};

export type ExclusiveAttempt = { acquired: true } | { acquired: false; cause: unknown };

/** One attempt at the exclusive transaction: `cause` is the busy error when another holder has it; any other failure
 *  is thrown. */
export const tryBeginExclusive = async (client: Client): Promise<ExclusiveAttempt> => {
  try {
    await client.execute('BEGIN EXCLUSIVE');
    return { acquired: true };
  } catch (cause) {
    if (isSqliteBusy(cause)) return { acquired: false, cause };
    throw cause;
  }
};

/** A failed rollback must never hide the error the caller is already throwing. */
export const rollbackQuietly = async (client: Client): Promise<void> => {
  try {
    await client.execute('ROLLBACK');
  } catch {
    // closing the client ends the transaction and frees the lock either way
  }
};

type LockAttempt = { lock: ExclusiveLock } | { lock: null; cause: unknown };

// A client that failed to begin must be closed, not retried: its later begin succeeds but its release leaves the OS
// lock held until the process exits.
const attemptExclusiveLock = async (lockPath: string): Promise<LockAttempt> => {
  const client = await openLockFile(lockPath);
  try {
    const attempt = await tryBeginExclusive(client);
    if (!attempt.acquired) {
      client.close();
      return { lock: null, cause: attempt.cause };
    }
  } catch (cause) {
    client.close();
    throw cause;
  }
  return {
    lock: {
      release: async () => {
        await rollbackQuietly(client);
        client.close();
      },
    },
  };
};

export const tryExclusiveLock = async (lockPath: string): Promise<ExclusiveLock | null> =>
  (await attemptExclusiveLock(lockPath)).lock;

export type LockWait = { waitMs: number; retryMs: number; timeoutMessage: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const acquireWithin = async (lockPath: string, deadline: number, wait: LockWait): Promise<ExclusiveLock> => {
  const attempt = await attemptExclusiveLock(lockPath);
  if (attempt.lock !== null) return attempt.lock;
  if (Date.now() >= deadline) throw new Error(wait.timeoutMessage, { cause: attempt.cause });
  await sleep(wait.retryMs);
  return acquireWithin(lockPath, deadline, wait);
};

export const waitForExclusiveLock = (lockPath: string, wait: LockWait): Promise<ExclusiveLock> =>
  acquireWithin(lockPath, Date.now() + wait.waitMs, wait);

export const withExclusiveLock = async <T>(lockPath: string, wait: LockWait, work: () => Promise<T>): Promise<T> => {
  const lock = await waitForExclusiveLock(lockPath, wait);
  try {
    return await work();
  } finally {
    await lock.release();
  }
};
