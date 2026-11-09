import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tryExclusiveLock } from '../../../../src/diplomat/db/file-lock.js';
import { withKeyLock } from '../../../../src/diplomat/db/key-lock.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patty-key-lock-'));
  lockPath = join(dir, 'nested', 'db-key.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('withKeyLock', () => {
  it('creates the lock directory, runs the work and answers its value', async () => {
    await expect(withKeyLock(async () => 'done', lockPath)).resolves.toBe('done');
  });

  it('releases the lock when the work throws', async () => {
    await expect(withKeyLock(() => Promise.reject(new Error('boom')), lockPath)).rejects.toThrow('boom');
    const again = await tryExclusiveLock(lockPath);
    expect(again).not.toBeNull();
    await again?.release();
  });

  it('runs two writers one after the other, never together', async () => {
    const events: string[] = [];
    const writer = (name: string) =>
      withKeyLock(async () => {
        events.push(`${name} in`);
        await new Promise((resolve) => setTimeout(resolve, 60));
        events.push(`${name} out`);
      }, lockPath);
    await Promise.all([writer('a'), writer('b')]);
    expect(events).toEqual(['a in', 'a out', 'b in', 'b out']);
  });

  it('leaves no lock held once contending writers are done', async () => {
    const slow = () => withKeyLock(() => new Promise<void>((resolve) => setTimeout(resolve, 100)), lockPath, 3_000);
    await Promise.all([slow(), slow()]);
    const again = await tryExclusiveLock(lockPath);
    expect(again).not.toBeNull();
    await again?.release();
  });

  it('waits for a holder that lets go within the wait', async () => {
    const first = await withKeyLock(async () => 1, lockPath);
    const held = await tryExclusiveLock(lockPath);
    setTimeout(() => void held?.release(), 100);
    await expect(withKeyLock(async () => first + 1, lockPath, 2_000)).resolves.toBe(2);
  });

  it('gives up with its own message, running no work, when the holder never lets go', async () => {
    await withKeyLock(async () => undefined, lockPath);
    const held = await tryExclusiveLock(lockPath);
    let ran = false;
    await expect(withKeyLock(async () => void (ran = true), lockPath, 150)).rejects.toThrow(
      /another patty process is writing the database key/,
    );
    expect(ran).toBe(false);
    await held?.release();
  });
});
