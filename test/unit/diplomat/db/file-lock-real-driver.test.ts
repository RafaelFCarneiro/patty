import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS } from '../../../../src/diplomat/db/driver.js';
import { tryExclusiveLock } from '../../../../src/diplomat/db/file-lock.js';

// Real driver, no mocks: a driver upgrade that stops a lock excluding (0.18 did for a raw BEGIN EXCLUSIVE) fails here.
let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patty-file-lock-'));
  lockPath = join(dir, 'x.lock');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tryExclusiveLock against the real driver', () => {
  it('refuses a second holder while the first holds, and grants it after the release', async () => {
    const first = await tryExclusiveLock(lockPath);
    expect(first).not.toBeNull();

    expect(await tryExclusiveLock(lockPath)).toBeNull();
    expect(await tryExclusiveLock(lockPath)).toBeNull();

    await first?.release();
    const second = await tryExclusiveLock(lockPath);
    expect(second).not.toBeNull();
    await second?.release();
  });

  it('answers a held lock at once, far below the busy timeout (it never blocks inside SQLite)', async () => {
    const first = await tryExclusiveLock(lockPath);
    const startedAt = Date.now();
    expect(await tryExclusiveLock(lockPath)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(BUSY_TIMEOUT_MS / 5);
    await first?.release();
  });
});
