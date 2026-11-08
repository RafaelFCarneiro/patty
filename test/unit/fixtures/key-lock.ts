import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { tryExclusiveLock, type ExclusiveLock } from '../../../src/diplomat/db/file-lock.js';

export const keyLockPathForTest = (): string =>
  join(tmpdir(), `fintrack-key-lock-test-${process.pid}-${threadId}.lock`);

export const acquireKeyLockForTest = async (): Promise<ExclusiveLock> => {
  const lock = await tryExclusiveLock(keyLockPathForTest());
  if (lock === null) throw new Error('the test key lock is already held');
  return lock;
};
