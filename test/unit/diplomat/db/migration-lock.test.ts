import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockPath, withMigrationLock } from '../../../../src/diplomat/db/migration-lock.js';

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patty-lock-'));
  dbFile = join(dir, 'patty.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tick = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('withMigrationLock', () => {
  it("holds the lock while working and returns the work's result", async () => {
    const result = await withMigrationLock(dbFile, async () => {
      expect(existsSync(lockPath(dbFile))).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
  });

  it('releases the lock even when the work throws', async () => {
    await expect(
      withMigrationLock(dbFile, async () => {
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');
    let ran = false;
    await withMigrationLock(dbFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('makes a second starter wait until the first has finished', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    let firstHoldsLock: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => (firstHoldsLock = resolve));
    const first = withMigrationLock(dbFile, async () => {
      events.push('first:start');
      firstHoldsLock();
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      events.push('first:end');
    });
    await acquired; // the first callback is running, so it provably holds the lock
    const second = withMigrationLock(dbFile, async () => {
      events.push('second:start');
    });
    await tick(250);
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('a waiting starter keeps the event loop free while it polls for the lock', async () => {
    let releaseFirst: () => void = () => undefined;
    let firstHoldsLock: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => (firstHoldsLock = resolve));
    const first = withMigrationLock(dbFile, async () => {
      firstHoldsLock();
      await new Promise<void>((resolve) => (releaseFirst = resolve));
    });
    await acquired;
    const second = withMigrationLock(dbFile, async () => undefined);

    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    await tick(300);
    clearInterval(timer);
    releaseFirst();
    await Promise.all([first, second]);

    expect(ticks).toBeGreaterThanOrEqual(20);
  });

  it('is not wedged by a leftover companion file (a crashed holder leaves nothing to clean up)', async () => {
    await withMigrationLock(dbFile, async () => undefined);
    expect(existsSync(lockPath(dbFile))).toBe(true); // kept on purpose: removing it would let two inodes be locked
    let ran = false;
    await withMigrationLock(dbFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('locks different databases independently', async () => {
    const other = join(dir, 'other.db');
    const events: string[] = [];
    let release: () => void = () => undefined;
    let holding: () => void = () => undefined;
    const acquired = new Promise<void>((resolve) => (holding = resolve));
    const held = withMigrationLock(dbFile, async () => {
      events.push('a');
      holding();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await acquired;
    await withMigrationLock(other, async () => {
      events.push('b');
    });
    expect(events).toEqual(['a', 'b']);
    release();
    await held;
  });
});
