import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { KEY_LOCK_PATH } from '../../config.js';
import { PRIVATE_DIRECTORY_MODE } from '../../models/export.js';
import { KEY_LOCK_RETRY_MS, KEY_LOCK_WAIT_MS } from '../../models/key-import.js';
import { tryExclusiveLock, type ExclusiveLock } from './file-lock.js';

export class KeyLockBusyError extends Error {
  constructor(lockPath: string) {
    super(`fintrack: another fintrack process is writing the database key (lock ${lockPath}); try again in a moment.`);
  }
}

const acquire = async (lockPath: string, deadline: number): Promise<ExclusiveLock> => {
  const lock = await tryExclusiveLock(lockPath);
  if (lock !== null) return lock;
  if (Date.now() >= deadline) throw new KeyLockBusyError(lockPath);
  await sleep(KEY_LOCK_RETRY_MS);
  return acquire(lockPath, deadline);
};

/** Runs `work` while holding the lock every writer of the keychain database key takes (the server generating one, an
 *  import storing one), so a check-then-write on the entry cannot interleave with another process's. Held by the OS,
 *  so a dead holder releases it. Reads of an entry that already holds a key never need it. */
export const withKeyLock = async <T>(
  work: () => Promise<T>,
  lockPath: string = KEY_LOCK_PATH,
  waitMs: number = KEY_LOCK_WAIT_MS,
): Promise<T> => {
  mkdirSync(dirname(lockPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const lock = await acquire(lockPath, Date.now() + waitMs);
  try {
    return await work();
  } finally {
    await lock.release();
  }
};
