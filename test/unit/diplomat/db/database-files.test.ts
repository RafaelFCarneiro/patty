import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireDatabaseLock, canonicalPath, removeDatabaseFiles } from '../../../../src/diplomat/db/database-files.js';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fintrack-db-files-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('canonicalPath', () => {
  it('is the real path of a file that exists, whatever the spelling or the link to it', () => {
    const file = join(dir, 'a.db');
    writeFileSync(file, '');
    symlinkSync(file, join(dir, 'link.db'));
    expect(canonicalPath(join(dir, 'link.db'))).toBe(file);
    expect(canonicalPath(join(dir, '..', dir.split('/').pop() ?? '', 'a.db'))).toBe(file);
  });

  it('is the directory’s real path plus the name for a path that does not exist yet', () => {
    expect(canonicalPath(join(dir, 'new.db'))).toBe(join(dir, 'new.db'));
  });

  it('follows one dangling link to the file it will create', () => {
    symlinkSync(join(dir, 'future.db'), join(dir, 'link.db'));
    expect(canonicalPath(join(dir, 'link.db'))).toBe(join(dir, 'future.db'));
  });

  it.each([
    [
      'a loop',
      () => [
        ['a.db', 'b.db'],
        ['b.db', 'a.db'],
      ],
    ],
    [
      'a link to another dangling link',
      () => [
        ['a.db', 'b.db'],
        ['b.db', 'c.db'],
      ],
    ],
  ])('is null for %s: it cannot be resolved', (_label, links) => {
    for (const [from, to] of links()) symlinkSync(join(dir, to as string), join(dir, from as string));
    expect(canonicalPath(join(dir, 'a.db'))).toBeNull();
  });
});

describe('removeDatabaseFiles', () => {
  it('removes the database and its sidecar files, and nothing else', () => {
    mkdirSync(join(dir, 'keep'));
    for (const name of ['d.db', 'd.db-wal', 'd.db-shm', 'd.db-journal', 'other.db']) writeFileSync(join(dir, name), '');
    removeDatabaseFiles(join(dir, 'd.db'));
    expect(['d.db', 'd.db-wal', 'd.db-shm', 'd.db-journal'].some((name) => existsSync(join(dir, name)))).toBe(false);
    expect(existsSync(join(dir, 'other.db'))).toBe(true);
  });

  it('is not an error when there is nothing to remove', () => {
    expect(() => removeDatabaseFiles(join(dir, 'missing.db'))).not.toThrow();
  });
});

describe('acquireDatabaseLock', () => {
  it('is exclusive until released, and creates the directory it needs', async () => {
    const path = join(dir, 'nested', 'd.db');
    const first = await acquireDatabaseLock(path);
    expect(first).not.toBeNull();
    expect(await acquireDatabaseLock(path)).toBeNull();
    await first?.release();
    const again = await acquireDatabaseLock(path);
    expect(again).not.toBeNull();
    await again?.release();
  });

  it('with three contenders: one holds, the others are refused, and one gets it once it is released', async () => {
    const path = join(dir, 'd.db');
    const a = await acquireDatabaseLock(path);
    const b = await acquireDatabaseLock(path);
    const c = await acquireDatabaseLock(path);
    expect([a === null, b === null, c === null]).toEqual([false, true, true]);
    await a?.release();
    const next = await acquireDatabaseLock(path);
    expect(next).not.toBeNull();
    await next?.release();
  });

  it('keeps the lock file after release (deleting it would give waiting runs a different file to lock)', async () => {
    const path = join(dir, 'd.db');
    await (await acquireDatabaseLock(path))?.release();
    expect(existsSync(`${path}.lock`)).toBe(true);
  });
});
