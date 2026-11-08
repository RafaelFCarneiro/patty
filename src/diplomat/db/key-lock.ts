import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRIVATE_DIRECTORY_MODE } from '../../models/export.js';
import { KEY_LOCK_RETRY_MS, KEY_LOCK_WAIT_MS } from '../../models/key-import.js';
import { waitForExclusiveLock } from './file-lock.js';

export const withKeyLock = async <T>(
  work: () => Promise<T>,
  lockPath: string,
  waitMs: number = KEY_LOCK_WAIT_MS,
): Promise<T> => {
  mkdirSync(dirname(lockPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const lock = await waitForExclusiveLock(lockPath, {
    waitMs,
    retryMs: KEY_LOCK_RETRY_MS,
    timeoutMessage: `fintrack: another fintrack process is writing the database key (lock ${lockPath}); try again in a moment.`,
  });
  try {
    return await work();
  } finally {
    await lock.release();
  }
};
