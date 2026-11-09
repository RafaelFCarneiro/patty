import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyDestination, snapshotDestination } from '../../../../src/diplomat/cli/export-file.js';
import type { Exporter } from '../../../../src/diplomat/cli/io.js';
import { CLI_MESSAGES } from '../../../../src/diplomat/cli/messages.js';

let root = '';
let dataDirectory = '';
let databaseFile = '';
let otherDirectory = '';

const exporterFor = (file: string): Exporter => ({
  databasePath: () => file,
  provenKey: () => Promise.reject(new Error('unused')),
  writeSnapshot: () => Promise.reject(new Error('unused')),
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'patty-export-file-')));
  dataDirectory = join(root, 'data');
  otherDirectory = join(root, 'compose');
  mkdirSync(join(dataDirectory, 'nested'), { recursive: true });
  mkdirSync(otherDirectory);
  databaseFile = join(dataDirectory, 'patty.db');
  writeFileSync(databaseFile, '');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('keyDestination', () => {
  const resolveKey = (to: string) => keyDestination(exporterFor(databaseFile), to);

  it('allows a new file in another directory', () => {
    expect(resolveKey(join(otherDirectory, 'patty_db_key'))._unsafeUnwrap()).toBe(
      join(otherDirectory, 'patty_db_key'),
    );
  });

  it('refuses the database directory', () => {
    expect(resolveKey(join(dataDirectory, 'key'))._unsafeUnwrapErr()).toBe(CLI_MESSAGES.keyBesideData(dataDirectory));
  });

  it('refuses a directory under the database directory', () => {
    const nested = join(dataDirectory, 'nested');
    expect(resolveKey(join(nested, 'key'))._unsafeUnwrapErr()).toBe(CLI_MESSAGES.keyBesideData(nested));
  });

  it('refuses a relative path that lands in the database directory', () => {
    const relativePath = join(relative(process.cwd(), dataDirectory), 'key');
    expect(resolveKey(relativePath).isErr()).toBe(true);
    expect(resolveKey(join(otherDirectory, '..', 'data', 'key')).isErr()).toBe(true);
  });

  it('refuses a symlinked directory that points into the database directory', () => {
    const link = join(otherDirectory, 'innocent');
    symlinkSync(dataDirectory, link);
    expect(resolveKey(join(link, 'key'))._unsafeUnwrapErr()).toBe(CLI_MESSAGES.keyBesideData(dataDirectory));
  });

  it('follows a symlinked database directory too', () => {
    const linkedData = join(root, 'linked-data');
    symlinkSync(dataDirectory, linkedData);
    const viaLink = keyDestination(exporterFor(join(linkedData, 'patty.db')), join(dataDirectory, 'key'));
    expect(viaLink.isErr()).toBe(true);
  });

  it('refuses the real database directory when the database file itself is a symlink', () => {
    const alias = join(otherDirectory, 'patty.db');
    symlinkSync(databaseFile, alias);
    const viaFileLink = keyDestination(exporterFor(alias), join(dataDirectory, 'key'));
    expect(viaFileLink._unsafeUnwrapErr()).toBe(CLI_MESSAGES.keyBesideData(dataDirectory));
  });

  it('refuses an existing file, and a dangling symlink', () => {
    const taken = join(otherDirectory, 'taken');
    writeFileSync(taken, 'x');
    expect(resolveKey(taken)._unsafeUnwrapErr()).toBe(CLI_MESSAGES.destinationExists(taken));
    const dangling = join(otherDirectory, 'dangling');
    symlinkSync(join(root, 'nowhere'), dangling);
    expect(resolveKey(dangling)._unsafeUnwrapErr()).toBe(CLI_MESSAGES.destinationExists(dangling));
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'refuses the database directory spelled in another case on a case-insensitive filesystem',
    () => {
      const shouted = join(root, 'DATA');
      if (!existsSync(shouted)) return; // a case-sensitive volume: nothing to bypass
      expect(resolveKey(join(shouted, 'key')).isErr()).toBe(true);
    },
  );

  it('refuses a directory that does not exist', () => {
    const missing = join(root, 'missing', 'key');
    expect(resolveKey(missing)._unsafeUnwrapErr()).toBe(CLI_MESSAGES.destinationDirectoryMissing(missing));
  });
});

describe('snapshotDestination', () => {
  const resolveSnapshot = (to: string) => snapshotDestination(exporterFor(databaseFile), to);

  it('allows a new file, even in the database directory', () => {
    expect(resolveSnapshot(join(dataDirectory, 'patty.snapshot.db')).isOk()).toBe(true);
    expect(resolveSnapshot(join(otherDirectory, 'patty.snapshot.db')).isOk()).toBe(true);
  });

  it('refuses the database itself, however it is spelled', () => {
    expect(resolveSnapshot(databaseFile)._unsafeUnwrapErr()).toBe(CLI_MESSAGES.snapshotIsDatabase(databaseFile));
    const link = join(otherDirectory, 'linked');
    symlinkSync(dataDirectory, link);
    expect(resolveSnapshot(join(link, 'patty.db'))._unsafeUnwrapErr()).toBe(
      CLI_MESSAGES.snapshotIsDatabase(databaseFile),
    );
  });

  it('refuses a directory that does not exist', () => {
    const missing = join(root, 'missing', 'patty.snapshot.db');
    expect(resolveSnapshot(missing)._unsafeUnwrapErr()).toBe(CLI_MESSAGES.destinationDirectoryMissing(missing));
  });

  it('refuses an existing file', () => {
    const taken = join(otherDirectory, 'taken.db');
    writeFileSync(taken, 'x');
    expect(resolveSnapshot(taken)._unsafeUnwrapErr()).toBe(CLI_MESSAGES.destinationExists(taken));
  });
});
