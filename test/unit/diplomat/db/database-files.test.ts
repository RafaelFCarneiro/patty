import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const probed = vi.hoisted(() => ({ files: [] as string[] }));

vi.mock('../../../../src/diplomat/db/export.js', async () => {
  const { readdirSync: list } = await import('node:fs');
  const { dirname: directoryOf } = await import('node:path');
  return {
    countSnapshotRows: async (copyPath: string) => {
      probed.files = list(directoryOf(copyPath)).sort();
      return { accounts: 0, transactions: 0 };
    },
  };
});

import { FILE_EXISTS_CODE } from '../../../../src/models/export.js';
import {
  acquireDatabaseLock,
  canonicalPath,
  countRowsOnCopy,
  discardStaged,
  hasDataBearingCompanion,
  publishStaged,
  stagePrivateCopy,
  removeDatabaseFiles,
} from '../../../../src/diplomat/db/database-files.js';

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'patty-db-files-')));
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

const copyNewPrivateFile = async (from: string, to: string): Promise<void> =>
  publishStaged(await stagePrivateCopy(from, to), to);

describe('copyNewPrivateFile', () => {
  it('copies into a new owner-only file', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    await copyNewPrivateFile(join(dir, 'from.db'), join(dir, 'data', 'to.db'));
    expect(readFileSync(join(dir, 'data', 'to.db'), 'utf8')).toBe('snapshot');
    expect(statSync(join(dir, 'data', 'to.db')).mode & 0o777).toBe(0o600);
  });

  it('leaves a file that was already there untouched, even when the source is gone too', async () => {
    writeFileSync(join(dir, 'to.db'), 'theirs');
    await expect(copyNewPrivateFile(join(dir, 'missing.db'), join(dir, 'to.db'))).rejects.toThrow();
    expect(readFileSync(join(dir, 'to.db'), 'utf8')).toBe('theirs');
  });

  it('removes the partial file it created when the source cannot be read', async () => {
    await expect(copyNewPrivateFile(join(dir, 'missing.db'), join(dir, 'to.db'))).rejects.toThrow();
    expect(existsSync(join(dir, 'to.db'))).toBe(false);
  });

  it('leaves only the published file behind, no staging copy', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    await copyNewPrivateFile(join(dir, 'from.db'), join(dir, 'to.db'));
    expect(readdirSync(dir).sort()).toEqual(['from.db', 'to.db']);
  });

  it('refuses a destination that appeared first, keeping it and leaving no staging copy', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    writeFileSync(join(dir, 'to.db'), 'theirs');
    const copy = copyNewPrivateFile(join(dir, 'from.db'), join(dir, 'to.db'));
    await expect(copy).rejects.toMatchObject({ code: FILE_EXISTS_CODE });
    expect(readFileSync(join(dir, 'to.db'), 'utf8')).toBe('theirs');
    expect(readdirSync(dir).sort()).toEqual(['from.db', 'to.db']);
  });

  it('refuses a dangling link at the destination without creating what it points to', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    symlinkSync(join(dir, 'future.db'), join(dir, 'to.db'));
    const copy = copyNewPrivateFile(join(dir, 'from.db'), join(dir, 'to.db'));
    await expect(copy).rejects.toMatchObject({ code: FILE_EXISTS_CODE });
    expect(existsSync(join(dir, 'future.db'))).toBe(false);
  });
});

describe('staged copies', () => {
  it('stages beside the destination without creating it, and discards on request', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    const staged = await stagePrivateCopy(join(dir, 'from.db'), join(dir, 'to.db'));
    expect(existsSync(join(dir, 'to.db'))).toBe(false);
    expect(readFileSync(staged.path, 'utf8')).toBe('snapshot');
    discardStaged(staged);
    expect(readdirSync(dir)).toEqual(['from.db']);
  });

  it('publishes the bytes that were staged, whatever the source becomes meanwhile', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    const staged = await stagePrivateCopy(join(dir, 'from.db'), join(dir, 'to.db'));
    writeFileSync(join(dir, 'from.db'), 'changed');
    await publishStaged(staged, join(dir, 'to.db'));
    expect(readFileSync(join(dir, 'to.db'), 'utf8')).toBe('snapshot');
  });

  it('removes the data directory it created when the staged copy is discarded, and only that', async () => {
    writeFileSync(join(dir, 'from.db'), 'snapshot');
    const created = await stagePrivateCopy(join(dir, 'from.db'), join(dir, 'new', 'deep', 'to.db'));
    discardStaged(created);
    expect(existsSync(join(dir, 'new'))).toBe(false);

    mkdirSync(join(dir, 'existing'));
    const reused = await stagePrivateCopy(join(dir, 'from.db'), join(dir, 'existing', 'to.db'));
    discardStaged(reused);
    expect(existsSync(join(dir, 'existing'))).toBe(true);
  });

  it('names a -wal or -journal beside a database as data it would not carry, a dangling link included', () => {
    expect(hasDataBearingCompanion(join(dir, 'a.db'))).toBe(false);
    writeFileSync(join(dir, 'a.db-shm'), '');
    expect(hasDataBearingCompanion(join(dir, 'a.db'))).toBe(false);
    symlinkSync(join(dir, 'nowhere'), join(dir, 'a.db-wal'));
    expect(hasDataBearingCompanion(join(dir, 'a.db'))).toBe(true);
    writeFileSync(join(dir, 'b.db-journal'), '');
    expect(hasDataBearingCompanion(join(dir, 'b.db'))).toBe(true);
  });
});

describe('countRowsOnCopy', () => {
  it('copies the log that sits beside a symlink’s target, not beside the link', async () => {
    mkdirSync(join(dir, 'real'));
    mkdirSync(join(dir, 'linked'));
    writeFileSync(join(dir, 'real', 'patty.db'), 'db');
    writeFileSync(join(dir, 'real', 'patty.db-wal'), 'wal');
    symlinkSync(join(dir, 'real', 'patty.db'), join(dir, 'linked', 'patty.db'));
    await countRowsOnCopy(join(dir, 'linked', 'patty.db'), 'k'.repeat(64));
    expect(probed.files).toEqual(['probe.db', 'probe.db-wal']);
  });
});
