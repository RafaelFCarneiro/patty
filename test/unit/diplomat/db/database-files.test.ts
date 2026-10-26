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
  it('is exclusive until released, and creates the directory it needs', () => {
    const path = join(dir, 'nested', 'd.db');
    const first = acquireDatabaseLock(path);
    expect(first).not.toBeNull();
    expect(acquireDatabaseLock(path)).toBeNull();
    first?.release();
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(acquireDatabaseLock(path)).not.toBeNull();
  });

  it('takes over a lock whose owner is gone, and respects one whose owner is alive', () => {
    const path = join(dir, 'd.db');
    writeFileSync(`${path}.lock`, 'not-a-pid');
    expect(acquireDatabaseLock(path)).not.toBeNull();
    writeFileSync(`${path}.lock`, String(process.pid));
    expect(acquireDatabaseLock(path)).toBeNull();
  });
});
