import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExporter } from '../../../src/composition/export.js';
import { createImporter } from '../../../src/composition/import.js';
import { runCli } from '../../../src/diplomat/cli/commands.js';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from '../../../src/diplomat/cli/io.js';
import { CLI_MESSAGES } from '../../../src/diplomat/cli/messages.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { MIGRATIONS_TABLE } from '../../../src/diplomat/db/migration-barrier.js';
import { accounts, transactions } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { PRIVATE_FILE_MODE } from '../../../src/models/export.js';
import { KeyImportRefusal } from '../../../src/models/key-import.js';
import type * as KeyLock from '../../../src/diplomat/db/key-lock.js';
import { unusedDemo } from '../../unit/fixtures/demo.js';

/**
 * `key import` and `db import` against real encrypted databases, in process: the importer and exporter are the
 * production ones (`composition/{import,export}.ts`), reading `DB_PATH` and the key sources from the environment as the
 * binary does. Only the OS keychain is replaced, by an in-memory entry.
 */
const KEY = 'a1'.repeat(32);
const OTHER_KEY = 'b2'.repeat(32);
const COUNTS = { accounts: 1, transactions: 1 };

const keychain = vi.hoisted(() => ({
  stored: null as string | null,
  broken: false,
  reads: 0,
  /** Another process writes this key just before the Nth read of the entry (1-based), as it would in the gap. */
  interloper: null as { atRead: number; key: string } | null,
}));

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword = () => {
      if (keychain.broken) throw new Error('keychain locked');
      keychain.reads += 1;
      if (keychain.interloper?.atRead === keychain.reads) keychain.stored = keychain.interloper.key;
      return keychain.stored;
    };
    setPassword = (password: string) => {
      if (keychain.broken) throw new Error('keychain locked');
      keychain.stored = password;
    };
  },
}));

vi.mock('../../../src/diplomat/db/key-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof KeyLock>();
  const { keyLockPathForTest } = await import('../../unit/fixtures/key-lock.js');
  return { ...actual, withKeyLock: <T>(work: () => Promise<T>) => actual.withKeyLock(work, keyLockPathForTest()) };
});

let root = '';
let sourceDatabase = '';
let installDirectory = '';
let installDatabase = '';
let outputDirectory = '';
let keyFile = '';
let snapshot = '';
let out: string[] = [];
let err: string[] = [];
let warnings: unknown[][] = [];

const io = (): CliIo =>
  ({
    openShell: () => {
      throw new Error('the import commands open no shell');
    },
    openTerminal: () => null,
    readPasswordFromStdin: async () => '',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: '0.0.0-test',
    wait: async () => undefined,
    interruptSignal: () => new AbortController().signal,
    clients: { find: () => undefined },
    exporter: createExporter(),
    importer: createImporter(),
    demo: unusedDemo,
  }) satisfies CliIo;

const run = (...args: string[]) => runCli(args, io());

const seedSource = async () => {
  const db = await openDatabase({ DB_PATH: sourceDatabase, FINTRACK_DB_KEY: KEY });
  await bootstrap(db);
  await db
    .insert(accounts)
    .values({ id: 'a1', name: 'Checking', type: 'checking', currency: 'USD', userId: OWNER_USER_ID });
  await db.insert(transactions).values({
    id: 't1',
    description: 'Coffee',
    amount: 3.5,
    type: 'expense',
    date: '2026-10-01',
    currency: 'USD',
    source: 'rest',
    idempotencyKey: 'k1',
    classificationMethod: 'none',
    confidence: 0,
    fromAccountId: 'a1',
    userId: OWNER_USER_ID,
  });
  closeDatabase(db);
};

const exportFromSource = async () => {
  vi.stubEnv('DB_PATH', sourceDatabase);
  vi.stubEnv('FINTRACK_DB_KEY', KEY);
  expect(await run('key', 'export', '--to', keyFile)).toBe(EXIT_OK);
  expect(await run('db', 'export', '--to', snapshot)).toBe(EXIT_OK);
  vi.stubEnv('DB_PATH', installDatabase);
  vi.stubEnv('FINTRACK_DB_KEY', undefined);
  out = [];
  err = [];
};

const countRows = async (config: Parameters<typeof openDatabase>[0]) => {
  const db = await openDatabase(config);
  try {
    const [row] = await db.all<{ accounts: number; transactions: number }>(
      sql`SELECT (SELECT count(*) FROM accounts) AS accounts, (SELECT count(*) FROM transactions) AS transactions`,
    );
    return row;
  } finally {
    closeDatabase(db);
  }
};

const modeOf = (file: string) => statSync(file).mode & 0o777;
const everythingPrinted = () => JSON.stringify([out, err, warnings]);
const writeKeyFile = (name: string, contents: string) => {
  const path = join(outputDirectory, name);
  writeFileSync(path, contents);
  return path;
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fintrack-import-')));
  sourceDatabase = join(root, 'a', 'fintrack.db');
  installDirectory = join(root, 'b', 'data');
  installDatabase = join(installDirectory, 'fintrack.db');
  outputDirectory = join(root, 'carry');
  keyFile = join(outputDirectory, 'fintrack_db_key');
  snapshot = join(outputDirectory, 'fintrack.snapshot.db');
  mkdirSync(outputDirectory);
  keychain.stored = null;
  keychain.broken = false;
  keychain.reads = 0;
  keychain.interloper = null;
  out = [];
  err = [];
  warnings = [];
  vi.stubEnv('FINTRACK_DB_KEY_FILE', undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args));
  await seedSource();
  await exportFromSource();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('fintrack key import', () => {
  it('stores the key in the keychain, which the server then opens an existing database with', async () => {
    mkdirSync(installDirectory, { recursive: true });
    copyFileSync(snapshot, installDatabase);

    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_OK);

    expect(keychain.stored).toBe(KEY);
    expect(await countRows({ DB_PATH: installDatabase })).toEqual(COUNTS);
    expect(out.join('\n')).toBe(CLI_MESSAGES.keyImported());
  });

  it('stores a key before any database exists, taking the format as the only proof', async () => {
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_OK);
    expect(keychain.stored).toBe(KEY);
    expect(existsSync(installDatabase)).toBe(false);
  });

  it('accepts a CRLF line ending', async () => {
    expect(await run('key', 'import', '--from', writeKeyFile('crlf', `${KEY}\r\n`))).toBe(EXIT_OK);
    expect(keychain.stored).toBe(KEY);
  });

  it('accepts the key without its trailing newline, and through a symlink as a mounted secret is', async () => {
    const bare = writeKeyFile('bare', KEY);
    const link = join(outputDirectory, 'link');
    symlinkSync(bare, link);
    expect(await run('key', 'import', '--from', link)).toBe(EXIT_OK);
    expect(keychain.stored).toBe(KEY);
  });

  it('refuses, keeping it, a key another process stores between the check and the store', async () => {
    keychain.interloper = { atRead: 2, key: OTHER_KEY };
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBe(OTHER_KEY);
    expect(err.join('\n')).toContain(CLI_MESSAGES.keyImportRefused(KeyImportRefusal.enum.keychain_holds_key));
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it.each([
    ['too short', 'a1a1\n'],
    ['not hexadecimal', `${'zz'.repeat(32)}\n`],
    ['two trailing newlines', `${KEY}\n\n`],
    ['surrounding whitespace', ` ${KEY}\n`],
    ['empty', ''],
    ['far too long', `${KEY}${'0'.repeat(4096)}`],
  ])('refuses a malformed key file (%s) without echoing it', async (_name, contents) => {
    const path = writeKeyFile('bad', contents);
    expect(await run('key', 'import', '--from', path)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBeNull();
    expect(err.join('\n')).toContain(CLI_MESSAGES.keyFileInvalid);
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it('refuses a missing file and a directory', async () => {
    expect(await run('key', 'import', '--from', join(outputDirectory, 'nope'))).toBe(EXIT_FAILURE);
    expect(await run('key', 'import', '--from', outputDirectory)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBeNull();
  });

  it('needs --from, and rejects stray arguments', async () => {
    expect(await run('key', 'import')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('--from <file>');
    expect(await run('key', 'import', 'extra', '--from', keyFile)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBeNull();
  });

  it('refuses, leaving it untouched, when the keychain already holds a key', async () => {
    keychain.stored = OTHER_KEY;
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBe(OTHER_KEY);
    expect(err.join('\n')).toContain(CLI_MESSAGES.keyImportRefused(KeyImportRefusal.enum.keychain_holds_key));
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it.each([
    ['FINTRACK_DB_KEY', KeyImportRefusal.enum.key_env_configured],
    ['FINTRACK_DB_KEY_FILE', KeyImportRefusal.enum.key_file_configured],
  ])('refuses while %s is set: that install reads its key from there', async (variable, refusal) => {
    vi.stubEnv(variable, variable === 'FINTRACK_DB_KEY' ? OTHER_KEY : keyFile);
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBeNull();
    expect(err.join('\n')).toContain(CLI_MESSAGES.keyImportRefused(refusal));
  });

  it('refuses, storing nothing, a key that does not open the database already here', async () => {
    mkdirSync(installDirectory, { recursive: true });
    copyFileSync(snapshot, installDatabase);
    const other = writeKeyFile('other', `${OTHER_KEY}\n`);

    expect(await run('key', 'import', '--from', other)).toBe(EXIT_FAILURE);

    expect(keychain.stored).toBeNull();
    expect(err.join('\n')).toContain(CLI_MESSAGES.keyDoesNotOpenDatabase(installDatabase));
    expect(everythingPrinted()).not.toContain(OTHER_KEY);
  });

  it('leaves the database it proved against exactly as it was', async () => {
    mkdirSync(installDirectory, { recursive: true });
    copyFileSync(snapshot, installDatabase);
    const before = readFileSync(installDatabase);
    await run('key', 'import', '--from', keyFile);
    expect(readFileSync(installDatabase).equals(before)).toBe(true);
    expect(existsSync(`${installDatabase}-wal`)).toBe(false);
  });

  it('fails cleanly, printing no key, when the keychain cannot be read', async () => {
    keychain.broken = true;
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('keychain locked');
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it('fails cleanly, as a failure and not a stack trace, when two key sources are configured', async () => {
    vi.stubEnv('FINTRACK_DB_KEY', KEY);
    vi.stubEnv('FINTRACK_DB_KEY_FILE', keyFile);
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_FAILURE);
    expect(keychain.stored).toBeNull();
  });

  it('prints the key nowhere: not on stdout, stderr or the log', async () => {
    await run('key', 'import', '--from', keyFile);
    await run('key', 'import', '--from', keyFile); // the refusal says nothing either
    expect(everythingPrinted()).not.toContain(KEY);
  });
});

describe('fintrack db import', () => {
  beforeEach(async () => {
    expect(await run('key', 'import', '--from', keyFile)).toBe(EXIT_OK);
    out = [];
  });

  it('puts the snapshot in place owner-only, creating the data directory, and prints the counts', async () => {
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_OK);

    expect(modeOf(installDatabase)).toBe(PRIVATE_FILE_MODE);
    expect(modeOf(installDirectory)).toBe(0o700);
    expect(existsSync(`${installDatabase}-wal`)).toBe(false);
    expect(out.join('\n')).toBe(CLI_MESSAGES.snapshotImported(installDatabase, COUNTS));
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it('round trip: opens with the imported key, bootstraps on first start, and holds the same data', async () => {
    await run('db', 'import', '--from', snapshot);

    const db = await openDatabase({ DB_PATH: installDatabase });
    await bootstrap(db);
    const migrations = await db.all(sql`SELECT hash FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY id`);
    const [account] = await db.all<{ name: string }>(sql`SELECT name FROM accounts WHERE id = 'a1'`);
    const [transaction] = await db.all<{ description: string; amount: number }>(
      sql`SELECT description, amount FROM transactions WHERE id = 't1'`,
    );
    closeDatabase(db);

    const source = await openDatabase({ DB_PATH: sourceDatabase, FINTRACK_DB_KEY: KEY });
    expect(await source.all(sql`SELECT hash FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY id`)).toEqual(migrations);
    closeDatabase(source);
    expect(account).toEqual({ name: 'Checking' });
    expect(transaction).toEqual({ description: 'Coffee', amount: 3.5 });
  });

  it('works with the key from a key file or the environment as well as the keychain', async () => {
    keychain.stored = null;
    vi.stubEnv('FINTRACK_DB_KEY_FILE', keyFile);
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_OK);
    expect(await countRows({ DB_PATH: installDatabase, FINTRACK_DB_KEY_FILE: keyFile })).toEqual(COUNTS);
  });

  it('refuses an existing database and leaves it untouched', async () => {
    mkdirSync(installDirectory, { recursive: true });
    writeFileSync(installDatabase, 'precious');
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(readFileSync(installDatabase, 'utf8')).toBe('precious');
    expect(err.join('\n')).toContain(CLI_MESSAGES.databaseExists(installDatabase));
  });

  it('refuses a dangling symlink at the database path', async () => {
    mkdirSync(installDirectory, { recursive: true });
    symlinkSync(join(root, 'nowhere'), installDatabase);
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(existsSync(join(root, 'nowhere'))).toBe(false);
  });

  it('refuses the database itself as the source and leaves it intact', async () => {
    await run('db', 'import', '--from', snapshot);
    out = [];
    err = [];
    expect(await run('db', 'import', '--from', installDatabase)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain(CLI_MESSAGES.snapshotIsDatabase(installDatabase));
    expect(await countRows({ DB_PATH: installDatabase })).toEqual(COUNTS);
  });

  it('refuses the database itself reached through a symlink', async () => {
    await run('db', 'import', '--from', snapshot);
    const link = join(outputDirectory, 'to-live');
    symlinkSync(installDatabase, link);
    expect(await run('db', 'import', '--from', link)).toBe(EXIT_FAILURE);
    expect(await countRows({ DB_PATH: installDatabase })).toEqual(COUNTS);
  });

  it('refuses a snapshot that does not open with the resolved key, creating nothing', async () => {
    keychain.stored = OTHER_KEY;
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(existsSync(installDirectory)).toBe(false);
    expect(err.join('\n')).toContain(CLI_MESSAGES.keyDoesNotOpenSnapshot(snapshot));
    expect(everythingPrinted()).not.toContain(OTHER_KEY);
  });

  it('refuses a file that is no database, creating nothing', async () => {
    const junk = writeKeyFile('junk.db', 'this is not a database'.repeat(100));
    expect(await run('db', 'import', '--from', junk)).toBe(EXIT_FAILURE);
    expect(existsSync(installDirectory)).toBe(false);
  });

  it.each(['-wal', '-journal'])('refuses a source with a %s beside it, creating nothing', async (suffix) => {
    writeFileSync(`${snapshot}${suffix}`, 'committed pages');
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain(CLI_MESSAGES.snapshotNotStandalone(snapshot));
    expect(err.join('\n')).toContain('db export');
    expect(existsSync(installDirectory)).toBe(false);
    expect(out).toEqual([]);
  });

  it('refuses a malformed keychain entry, creating nothing', async () => {
    keychain.stored = 'not-a-valid-key';
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(existsSync(installDirectory)).toBe(false);
  });

  it('refuses while a -wal file is left beside the database path, creating no database', async () => {
    mkdirSync(installDirectory, { recursive: true });
    writeFileSync(`${installDatabase}-wal`, 'stale');
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(existsSync(installDatabase)).toBe(false);
    expect(err.join('\n')).toContain(CLI_MESSAGES.databaseLeftovers(installDatabase));
  });

  it('refuses without any key, and does not generate one', async () => {
    keychain.stored = null;
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain(CLI_MESSAGES.noKeyToImport);
    expect(keychain.stored).toBeNull();
    expect(existsSync(installDirectory)).toBe(false);
  });

  it('refuses, creating nothing, a snapshot that gains a -wal after the standalone check', async () => {
    writeFileSync(`${snapshot}-wal`, 'late');
    const staged = await createImporter().stageSnapshot(snapshot);
    expect(staged._unsafeUnwrapErr()).toBe(CLI_MESSAGES.snapshotNotStandalone(snapshot));
    expect(existsSync(installDirectory)).toBe(false);
  });

  it('fails as a CLI failure, not a crash, when the configuration itself is invalid', async () => {
    vi.stubEnv('FINTRACK_DB_KEY', KEY);
    vi.stubEnv('FINTRACK_DB_KEY_FILE', keyFile);
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('FINTRACK_DB_KEY');
    expect(existsSync(installDatabase)).toBe(false);
  });

  it('refuses a missing source, and needs --from', async () => {
    expect(await run('db', 'import', '--from', join(outputDirectory, 'nope.db'))).toBe(EXIT_FAILURE);
    expect(await run('db', 'import')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('--from <file>');
    expect(existsSync(installDirectory)).toBe(false);
  });

  it('leaves the snapshot untouched, and never removes a database that appears meanwhile', async () => {
    const before = readFileSync(snapshot);
    await run('db', 'import', '--from', snapshot);
    expect(readFileSync(snapshot).equals(before)).toBe(true);

    const importer = createImporter();
    const staged = await importer.stageSnapshot(snapshot);
    expect(staged.isOk()).toBe(true);
    const placed = await importer.publishSnapshot(staged._unsafeUnwrap());
    expect(placed.isErr()).toBe(true);
    expect(await countRows({ DB_PATH: installDatabase })).toEqual(COUNTS);
  });

  it('copies a read-only snapshot to an owner-only file all the same', async () => {
    chmodSync(snapshot, 0o444);
    expect(await run('db', 'import', '--from', snapshot)).toBe(EXIT_OK);
    expect(modeOf(installDatabase)).toBe(PRIVATE_FILE_MODE);
  });
});

describe('the import commands without a subcommand', () => {
  it('print help that names the order of a move', async () => {
    expect(await run('key')).toBe(EXIT_OK);
    expect(await run('db')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('key import first, then db import, then setup <client>');
  });
});
