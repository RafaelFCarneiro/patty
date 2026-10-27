import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExporter } from '../../../src/composition/export.js';
import { runCli } from '../../../src/diplomat/cli/commands.js';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from '../../../src/diplomat/cli/io.js';
import { CLI_MESSAGES } from '../../../src/diplomat/cli/messages.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { MIGRATIONS_TABLE } from '../../../src/diplomat/db/migration-barrier.js';
import { accounts, transactions } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { PRIVATE_FILE_MODE } from '../../../src/models/export.js';
import { unusedDemo } from '../../unit/fixtures/demo.js';

/**
 * `key export` and `db export` against a real encrypted database, in process: the exporter is the production one
 * (`composition/export.ts`), reading `DB_PATH` and the key from the environment as the binary does.
 */
const KEY = 'a1'.repeat(32);
const OTHER_KEY = 'b2'.repeat(32);

let root = '';
let dataDirectory = '';
let dbPath = '';
let outputDirectory = '';
let out: string[] = [];
let err: string[] = [];
let warnings: unknown[][] = [];

const io = (): CliIo =>
  ({
    openShell: () => {
      throw new Error('the export commands open no shell');
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
    demo: unusedDemo,
  }) satisfies CliIo;

const run = (...args: string[]) => runCli(args, io());

const seedDatabase = async () => {
  const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: KEY });
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

const countRows = async (file: string, key: string) => {
  const db = await openDatabase({ DB_PATH: file, FINTRACK_DB_KEY: key });
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

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fintrack-export-')));
  dataDirectory = join(root, 'data');
  outputDirectory = join(root, 'compose');
  mkdirSync(outputDirectory);
  dbPath = join(dataDirectory, 'fintrack.db');
  out = [];
  err = [];
  warnings = [];
  vi.stubEnv('DB_PATH', dbPath);
  vi.stubEnv('FINTRACK_DB_KEY', KEY);
  vi.stubEnv('FINTRACK_DB_KEY_FILE', undefined);
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args));
  await seedDatabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('fintrack key export', () => {
  it('writes exactly the key, owner-only, and the file opens the database as FINTRACK_DB_KEY_FILE', async () => {
    const keyFile = join(outputDirectory, 'fintrack_db_key');
    expect(await run('key', 'export', '--to', keyFile)).toBe(EXIT_OK);

    expect(readFileSync(keyFile, 'utf8')).toBe(`${KEY}\n`);
    expect(modeOf(keyFile)).toBe(PRIVATE_FILE_MODE);
    const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY_FILE: keyFile });
    expect(await db.all(sql`SELECT count(*) AS n FROM accounts`)).toEqual([{ n: 1 }]);
    closeDatabase(db);
    expect(out.join('\n')).toBe(CLI_MESSAGES.keyExported(keyFile));
  });

  it('prints the key nowhere: not on stdout, stderr or the log', async () => {
    await run('key', 'export', '--to', join(outputDirectory, 'fintrack_db_key'));
    await run('key', 'export', '--to', join(outputDirectory, 'fintrack_db_key')); // the refusal says nothing either
    await run('key', 'export', '--to', join(dataDirectory, 'fintrack_db_key'));
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it('refuses an existing file and leaves it untouched', async () => {
    const keyFile = join(outputDirectory, 'fintrack_db_key');
    writeFileSync(keyFile, 'precious');
    expect(await run('key', 'export', '--to', keyFile)).toBe(EXIT_FAILURE);
    expect(readFileSync(keyFile, 'utf8')).toBe('precious');
    expect(err.join('\n')).toContain(CLI_MESSAGES.destinationExists(keyFile));
  });

  it('refuses the database directory and writes nothing there', async () => {
    const keyFile = join(dataDirectory, 'fintrack_db_key');
    expect(await run('key', 'export', '--to', keyFile)).toBe(EXIT_FAILURE);
    expect(existsSync(keyFile)).toBe(false);
    expect(err.join('\n')).toContain('never sit next to the data');
  });

  it('refuses, writing nothing, when the key does not open the database', async () => {
    vi.stubEnv('FINTRACK_DB_KEY', OTHER_KEY);
    const keyFile = join(outputDirectory, 'fintrack_db_key');
    expect(await run('key', 'export', '--to', keyFile)).toBe(EXIT_FAILURE);
    expect(existsSync(keyFile)).toBe(false);
    expect(everythingPrinted()).not.toContain(OTHER_KEY);
  });

  it('refuses, writing nothing, when there is no database', async () => {
    vi.stubEnv('DB_PATH', join(dataDirectory, 'missing.db'));
    const keyFile = join(outputDirectory, 'fintrack_db_key');
    expect(await run('key', 'export', '--to', keyFile)).toBe(EXIT_FAILURE);
    expect(existsSync(keyFile)).toBe(false);
    expect(err.join('\n')).toContain('there is no database at');
  });

  it('needs --to, and rejects stray arguments', async () => {
    expect(await run('key', 'export')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('--to <file>');
    expect(await run('key', 'export', 'extra', '--to', join(outputDirectory, 'k'))).toBe(EXIT_FAILURE);
    expect(await run('key', 'import')).toBe(EXIT_FAILURE);
  });
});

describe('fintrack db export', () => {
  it('writes a snapshot that opens with the same key and holds the same rows, owner-only', async () => {
    const snapshot = join(outputDirectory, 'fintrack.snapshot.db');
    expect(await run('db', 'export', '--to', snapshot)).toBe(EXIT_OK);

    expect(modeOf(snapshot)).toBe(PRIVATE_FILE_MODE);
    expect(existsSync(`${snapshot}-wal`)).toBe(false);
    expect(await countRows(snapshot, KEY)).toEqual({ accounts: 1, transactions: 1 });
    expect(out.join('\n')).toBe(CLI_MESSAGES.snapshotExported(snapshot, { accounts: 1, transactions: 1 }));
    expect(everythingPrinted()).not.toContain(KEY);
  });

  it('is encrypted: the wrong key cannot read it', async () => {
    const snapshot = join(outputDirectory, 'fintrack.snapshot.db');
    await run('db', 'export', '--to', snapshot);
    await expect(countRows(snapshot, OTHER_KEY)).rejects.toThrow();
  });

  it('refuses an existing file and leaves it untouched', async () => {
    const snapshot = join(outputDirectory, 'fintrack.snapshot.db');
    writeFileSync(snapshot, 'precious');
    expect(await run('db', 'export', '--to', snapshot)).toBe(EXIT_FAILURE);
    expect(readFileSync(snapshot, 'utf8')).toBe('precious');
  });

  it('refuses DB_PATH itself and leaves the database intact', async () => {
    expect(await run('db', 'export', '--to', dbPath)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain(CLI_MESSAGES.snapshotIsDatabase(dbPath));
    expect(await countRows(dbPath, KEY)).toEqual({ accounts: 1, transactions: 1 });
  });

  it('never removes a file that was already there when the copy is refused', async () => {
    const snapshot = join(outputDirectory, 'fintrack.snapshot.db');
    writeFileSync(snapshot, 'precious');
    expect((await createExporter().writeSnapshot(snapshot)).isErr()).toBe(true);
    expect(readFileSync(snapshot, 'utf8')).toBe('precious');
  });

  it('fails cleanly, creating nothing, when the destination directory is missing', async () => {
    const snapshot = join(outputDirectory, 'missing', 'fintrack.snapshot.db');
    expect(await run('db', 'export', '--to', snapshot)).toBe(EXIT_FAILURE);
    expect(existsSync(snapshot)).toBe(false);
  });

  it('rejects an unknown flag', async () => {
    expect(await run('db', 'export', '--force', '--to', join(outputDirectory, 's.db'))).toBe(EXIT_FAILURE);
    expect(existsSync(join(outputDirectory, 's.db'))).toBe(false);
  });

  it('leaves nothing behind when the key does not open the database', async () => {
    vi.stubEnv('FINTRACK_DB_KEY', OTHER_KEY);
    const snapshot = join(outputDirectory, 'fintrack.snapshot.db');
    expect(await run('db', 'export', '--to', snapshot)).toBe(EXIT_FAILURE);
    expect(existsSync(snapshot)).toBe(false);
  });

  it('does not migrate the source: a database with a migration still pending stays that way', async () => {
    const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: KEY });
    await db.run(
      sql`DELETE FROM ${sql.identifier(MIGRATIONS_TABLE)} WHERE id = (SELECT max(id) FROM ${sql.identifier(MIGRATIONS_TABLE)})`,
    );
    const appliedBefore = await db.all(
      sql`SELECT hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY id`,
    );
    closeDatabase(db);

    expect(await run('db', 'export', '--to', join(outputDirectory, 'fintrack.snapshot.db'))).toBe(EXIT_OK);

    const after = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: KEY });
    expect(await after.all(sql`SELECT hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY id`)).toEqual(
      appliedBefore,
    );
    closeDatabase(after);
  });
});

describe('the export commands without a subcommand', () => {
  it('print their help', async () => {
    expect(await run('key')).toBe(EXIT_OK);
    expect(await run('db')).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('key <command>');
    expect(out.join('\n')).toContain('db <command>');
  });
});
