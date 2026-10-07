import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { backupPath } from '../../../src/diplomat/db/safetyCopy.js';
import { OWNER_USER_ID } from '../../../src/models/auth.js';

const TEST_KEY = 'd'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const AUTH_MIGRATION_TAG = '0018_auth_identity';

let tmpDir: string;
let dbPath: string;
let preAuthFolder: string;
let stderr: ReturnType<typeof vi.spyOn>;

/** A copy of the real migrations folder whose journal stops just before the auth migration — a database
 *  created by any release that predates ADR-033. */
const journalBeforeAuth = (folder: string): void => {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === AUTH_MIGRATION_TAG);
  if (cutoff === -1) throw new Error(`${AUTH_MIGRATION_TAG} not in ${journalPath}`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
};

const open = () => openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: TEST_KEY });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-owner-migration-'));
  dbPath = join(tmpDir, 'fintrack.db');
  preAuthFolder = join(tmpDir, 'pre-auth-migrations');
  cpSync(REAL_MIGRATIONS_FOLDER, preAuthFolder, { recursive: true });
  journalBeforeAuth(preAuthFolder);
  stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

// drizzle's bookkeeping, sqlite internals, the FTS shadow tables, and the tables this migration adds.
const EXCLUDED_TABLES = /^(__drizzle|sqlite_|transactions_fts|users$|sessions$|setup_codes$)/;

/** Every table outside the auth ones and drizzle's bookkeeping, fully dumped and ordered — the database's
 *  domain content, to compare byte-for-byte before and after the migration. */
const domainDump = async (db: Db): Promise<Record<string, Row[]>> => {
  const tables = (
    await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
  ).filter(({ name }) => !EXCLUDED_TABLES.test(name));
  const dump: Record<string, Row[]> = {};
  for (const { name } of tables) {
    const rows = await db.all<Row>(sql`SELECT * FROM ${sql.identifier(name)}`);
    dump[name] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return dump;
};

const seedDomainData = async (db: Db): Promise<void> => {
  await db.run(
    sql`INSERT INTO accounts (id, name, type, initial_balance, currency, version) VALUES ('acc-1', 'Checking', 'checking', 1000, 'USD', 3)`,
  );
  await db.run(
    sql`INSERT INTO accounts (id, name, type, initial_balance, currency, version) VALUES ('acc-2', 'Savings', 'savings', 250.5, 'BRL', 0)`,
  );
  await db.run(
    sql`INSERT INTO transactions (id, description, amount, type, status, date, currency, source, idempotency_key, classification_method, confidence, from_account_id, category_id, version)
        VALUES ('tx-1', 'Groceries', 42.5, 'expense', 'effective', '2026-09-01', 'USD', 'mcp', 'legacy-readable-key', 'rule', 0.8, 'acc-1', 'cat-food', 1)`,
  );
  await db.run(
    sql`INSERT INTO settings (id, locale, locale_source, version) VALUES ('singleton', 'pt', 'explicit', 2)`,
  );
};

const balanceOf = async (db: Db, accountId: string): Promise<number> => {
  const [row] = await db.all<{ balance: number }>(
    sql`SELECT a.initial_balance - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND type = 'expense' AND status = 'effective'), 0) AS balance FROM accounts a WHERE a.id = ${accountId}`,
  );
  return row?.balance ?? Number.NaN;
};

const ownerRows = (db: Db) =>
  db.all<{ id: string; username: string | null; password_hash: string | null; role: string; version: number }>(
    sql`SELECT id, username, password_hash, role, version FROM users`,
  );

describe('migration 0018 — the owner row (ADR-033 §7)', () => {
  it('lists the auth migration as data-rewriting, in one place', () => {
    expect(DATA_REWRITING_MIGRATIONS).toContain(AUTH_MIGRATION_TAG);
  });

  it('inserts exactly one owner into an existing database and leaves every domain row untouched', async () => {
    const legacy = await open();
    await bootstrap(legacy, preAuthFolder);
    await seedDomainData(legacy);
    const beforeDump = await domainDump(legacy);
    const beforeBalances = [await balanceOf(legacy, 'acc-1'), await balanceOf(legacy, 'acc-2')];
    expect((await legacy.all(sql`SELECT name FROM sqlite_master WHERE name = 'users'`)).length).toBe(0);

    await bootstrap(legacy);

    expect(await ownerRows(legacy)).toEqual([
      { id: OWNER_USER_ID, username: null, password_hash: null, role: 'admin', version: 0 },
    ]);
    expect(await domainDump(legacy)).toEqual(beforeDump);
    expect([await balanceOf(legacy, 'acc-1'), await balanceOf(legacy, 'acc-2')]).toEqual(beforeBalances);
    expect(beforeBalances).toEqual([957.5, 250.5]);
    expect(await legacy.all(sql`SELECT * FROM sessions`)).toEqual([]);
    expect(await legacy.all(sql`SELECT * FROM setup_codes`)).toEqual([]);
  });

  it('writes a restricted .bak of the pre-migration database and says so on stderr', async () => {
    const legacy = await open();
    await bootstrap(legacy, preAuthFolder);
    await seedDomainData(legacy);
    const beforeDump = await domainDump(legacy);

    await bootstrap(legacy);

    const backup = backupPath(dbPath, AUTH_MIGRATION_TAG);
    expect(backup).toBe(`${dbPath}.pre-${AUTH_MIGRATION_TAG}.bak`);
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o077).toBe(0);
    expect(stderr.mock.calls.flat().join(' ')).toContain(backup);
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(TEST_KEY);

    // The copy is the pre-migration state: same encrypted file, same key, no auth tables, same data.
    const restored = await openDatabase({ DB_PATH: backup, FINTRACK_DB_KEY: TEST_KEY });
    expect(await restored.all(sql`SELECT name FROM sqlite_master WHERE name = 'users'`)).toEqual([]);
    expect(await domainDump(restored)).toEqual(beforeDump);
  });

  it('keeps the owner and writes no second backup when startup runs again', async () => {
    const legacy = await open();
    await bootstrap(legacy, preAuthFolder);
    await seedDomainData(legacy);
    await bootstrap(legacy);
    const backup = backupPath(dbPath, AUTH_MIGRATION_TAG);
    const firstCopy = statSync(backup).mtimeMs;
    stderr.mockClear();

    await bootstrap(legacy);
    const reopened = await open();
    await bootstrap(reopened);

    expect(await ownerRows(reopened)).toHaveLength(1);
    expect(statSync(backup).mtimeMs).toBe(firstCopy);
    expect(stderr.mock.calls.flat().join(' ')).not.toContain('backed up');
  });

  it('keeps the pre-migration backup intact when two starters race (several stdio servers, ADR-024)', async () => {
    const legacy = await open();
    await bootstrap(legacy, preAuthFolder);
    await seedDomainData(legacy);
    const beforeDump = await domainDump(legacy);
    const first = await open();
    const second = await open();

    await Promise.all([bootstrap(first), bootstrap(second)]);

    expect(await ownerRows(first)).toHaveLength(1);
    // Neither starter copied the other's already-migrated file over the good backup.
    const restored = await openDatabase({ DB_PATH: backupPath(dbPath, AUTH_MIGRATION_TAG), FINTRACK_DB_KEY: TEST_KEY });
    expect(await restored.all(sql`SELECT name FROM sqlite_master WHERE name = 'users'`)).toEqual([]);
    expect(await domainDump(restored)).toEqual(beforeDump);
    expect(
      stderr.mock.calls
        .flat()
        .join(' ')
        .match(/backed up the database/g),
    ).toHaveLength(1);
  });

  it('creates the owner on a brand-new database and takes no backup of nothing', async () => {
    const fresh = await open();
    await bootstrap(fresh);

    expect(await ownerRows(fresh)).toEqual([
      { id: OWNER_USER_ID, username: null, password_hash: null, role: 'admin', version: 0 },
    ]);
    expect(existsSync(backupPath(dbPath, AUTH_MIGRATION_TAG))).toBe(false);
    expect(stderr.mock.calls.flat().join(' ')).not.toContain('backed up');
  });

  it('leaves an already-claimed owner alone on the next startup', async () => {
    const db = await open();
    await bootstrap(db);
    await db.run(sql`UPDATE users SET username = 'rafael', password_hash = '$argon2id$stub', version = 1`);
    await bootstrap(db);
    expect(await ownerRows(db)).toEqual([
      { id: OWNER_USER_ID, username: 'rafael', password_hash: '$argon2id$stub', role: 'admin', version: 1 },
    ]);
  });
});
