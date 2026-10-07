import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockPath, withMigrationLock } from '../../../../src/diplomat/db/migrationLock.js';

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-lock-'));
  dbFile = join(dir, 'fintrack.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tick = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('withMigrationLock', () => {
  it('holds a pid-stamped lock file while working and removes it afterwards', async () => {
    await withMigrationLock(dbFile, async () => {
      expect(existsSync(lockPath(dbFile))).toBe(true);
    });
    expect(existsSync(lockPath(dbFile))).toBe(false);
  });

  it('releases the lock even when the work throws', async () => {
    await expect(
      withMigrationLock(dbFile, async () => {
        throw new Error('migration failed');
      }),
    ).rejects.toThrow('migration failed');
    expect(existsSync(lockPath(dbFile))).toBe(false);
  });

  it('makes a second starter wait until the first has finished', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = withMigrationLock(dbFile, async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      events.push('first:end');
    });
    await tick();
    const second = withMigrationLock(dbFile, async () => {
      events.push('second:start');
    });
    await tick(250);
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('breaks a lock whose owner process is gone', async () => {
    writeFileSync(lockPath(dbFile), '2147483646'); // no such pid
    let ran = false;
    await withMigrationLock(dbFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('breaks an unreadable (garbled) lock rather than waiting on it forever', async () => {
    writeFileSync(lockPath(dbFile), 'not a pid');
    let ran = false;
    await withMigrationLock(dbFile, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
