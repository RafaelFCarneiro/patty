import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRIVATE_DIRECTORY_MODE } from '../../models/export.js';
import { KEY_LOCK_RETRY_MS, KEY_LOCK_WAIT_MS } from '../../models/key-import.js';
import { withExclusiveLock } from './file-lock.js';
import { LOG_PREFIX } from '../../models/package.js';

export const withKeyLock = <T>(
  work: () => Promise<T>,
  lockPath: string,
  waitMs: number = KEY_LOCK_WAIT_MS,
): Promise<T> => {
  mkdirSync(dirname(lockPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  return withExclusiveLock(
    lockPath,
    {
      waitMs,
      retryMs: KEY_LOCK_RETRY_MS,
      timeoutMessage: `${LOG_PREFIX} another patty process is writing the database key (lock ${lockPath}); try again in a moment.`,
    },
    work,
  );
};
