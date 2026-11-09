import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is, sql } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '../../../src/diplomat/db/schema.js';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { backupPath } from '../../../src/diplomat/db/safety-copy.js';
import {
  assertOwnedRowsHaveKnownUsers,
  findRowsWithoutKnownUser,
  OWNED_TABLES,
  SHARED_OR_OWNED_TABLES,
} from '../../../src/diplomat/db/tenancy-integrity.js';
import { DefaultCategoryId } from '../../../src/diplomat/db/seed/categories.js';
import { seedAsBefore } from './legacy-seed.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

const TEST_KEY = 'e'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const TENANCY_MIGRATION_TAG = '0021_tenancy_data';
const MIGRATION_FILE = join(REAL_MIGRATIONS_FOLDER, `${TENANCY_MIGRATION_TAG}.sql`);

let tmpDir: string;
let dbPath: string;
let preTenancyFolder: string;

/** A copy of the real migrations whose journal stops just before the tenancy migration — a database as the last
 *  release before tenancy left it. */
const journalBeforeTenancy = (folder: string): void => {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === TENANCY_MIGRATION_TAG);
  if (cutoff === -1) throw new Error(`${TENANCY_MIGRATION_TAG} not in ${journalPath}`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
};

const open = () => openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, FINTRACK_DB_KEY: TEST_KEY });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-tenancy-migration-'));
  dbPath = join(tmpDir, 'fintrack.db');
  preTenancyFolder = join(tmpDir, 'pre-tenancy-migrations');
  cpSync(REAL_MIGRATIONS_FOLDER, preTenancyFolder, { recursive: true });
  journalBeforeTenancy(preTenancyFolder);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

// Everything the migration rebuilds or adds, dumped without the new column, to compare before and after.
const OWNED_AND_SHARED = [...OWNED_TABLES, ...SHARED_OR_OWNED_TABLES, 'transaction_tags', 'merchants', 'currencies'];

const dumpTable = async (db: Db, table: string, dropUserId: boolean): Promise<Row[]> => {
  const rows = await db.all<Row>(sql`SELECT * FROM ${sql.identifier(table)}`);
  const shaped = dropUserId ? rows.map(({ user_id: _userId, ...rest }) => rest) : rows;
  return shaped.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

const domainDump = async (db: Db, dropUserId: boolean): Promise<Record<string, Row[]>> => {
  const dump: Record<string, Row[]> = {};
  for (const table of OWNED_AND_SHARED) dump[table] = await dumpTable(db, table, dropUserId);
  return dump;
};

/** What a long-lived stdio database holds: every row global, nobody owning it. */
const seedLegacyData = async (db: Db): Promise<void> => {
  const run = (statement: ReturnType<typeof sql>) => db.run(statement);
  await run(
    sql`INSERT INTO accounts (id, name, type, initial_balance, currency, version) VALUES ('acc-1', 'Checking', 'checking', 1000, 'USD', 3)`,
  );
  await run(
    sql`INSERT INTO accounts (id, name, type, initial_balance, currency, version) VALUES ('acc-card', 'Card: Visa', 'credit', 0, 'USD', 0)`,
  );
  await run(
    sql`INSERT INTO credit_cards (id, name, closing_day, due_day, currency, account_id, payment_account_id, version) VALUES ('card-1', 'Visa', 10, 20, 'USD', 'acc-card', 'acc-1', 1)`,
  );
  await run(
    sql`INSERT INTO bills (id, credit_card_id, month, year, close_date, due_date, status, version) VALUES ('bill-1', 'card-1', 9, 2026, '2026-09-10', '2026-09-20', 'open', 0)`,
  );
  await run(
    sql`INSERT INTO categories (id, name, kind, parent_id, names, version) VALUES ('cat-mine', 'Pets', 'expense', NULL, NULL, 0)`,
  );
  await run(
    sql`INSERT INTO categories (id, name, kind, parent_id, names, version) VALUES ('sub-mine', 'Vet', 'expense', 'cat-mine', NULL, 0)`,
  );
  await run(
    sql`INSERT INTO categories (id, name, kind, parent_id, names, version) VALUES ('sub-under-default', 'Takeaway', 'expense', 'cat-food', NULL, 0)`,
  );
  await run(sql`INSERT OR IGNORE INTO merchants (key) VALUES ('mercado'), ('petshop')`);
  await run(
    sql`INSERT INTO merchant_category (merchant_key, category_id, weight, origin, last_seen) VALUES ('petshop', 'cat-mine', 4, 'history', 2026)`,
  );
  await run(sql`INSERT INTO tags (id, name, version) VALUES ('tag-1', 'trip', 0), ('tag-2', 'work', 0)`);
  await run(
    sql`INSERT INTO transactions (id, description, amount, type, status, date, currency, source, idempotency_key, classification_method, confidence, from_account_id, category_id, merchant_key, version) VALUES ('tx-1', 'Groceries at Mercado', 42.5, 'expense', 'effective', '2026-09-01', 'USD', 'mcp', 'legacy-readable-key', 'rule', 0.8, 'acc-1', 'cat-food', 'mercado', 1)`,
  );
  await run(
    sql`INSERT INTO transactions (id, description, amount, type, status, date, currency, source, idempotency_key, classification_method, confidence, from_account_id, credit_card_id, bill_id, version) VALUES ('tx-2', 'Vet visit', 80, 'expense', 'effective', '2026-09-03', 'USD', 'mcp', 'legacy-key-2', 'user', 1, 'acc-card', 'card-1', 'bill-1', 0)`,
  );
  await run(
    sql`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ('tx-1', 'tag-1'), ('tx-1', 'tag-2'), ('tx-2', 'tag-1')`,
  );
  await run(
    sql`INSERT INTO budgets (id, category_id, currency, limit_amount, period, version) VALUES ('bud-1', 'cat-food', 'USD', 300, 'monthly', 0)`,
  );
  await run(
    sql`INSERT INTO recurring_rules (id, description, amount, type, period, next_due, currency, account_id, category_id, merchant_key, version) VALUES ('rec-1', 'Rent', 900, 'expense', 'monthly', '2026-10-01', 'USD', 'acc-1', NULL, NULL, 0)`,
  );
};

const countOf = async (db: Db, table: string): Promise<number> => {
  const [row] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table)}`);
  return row?.n ?? Number.NaN;
};

const seedOwnerSettings = async (db: Db): Promise<void> => {
  await db.run(
    sql`INSERT OR REPLACE INTO settings (id, locale, locale_source, base_currency, version) VALUES ('singleton', 'pt', 'explicit', 'BRL', 2)`,
  );
};

/** What a failed statement says, wherever in the cause chain drizzle and libsql put it. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.message} ${messageOf(error.cause)}` : String(error ?? '');

const rejectsWith = async (work: Promise<unknown>, pattern: RegExp): Promise<void> => {
  const outcome = await work.then(
    () => null,
    (error: unknown) => messageOf(error),
  );
  expect(outcome, 'the statement should have been refused').not.toBeNull();
  expect(outcome).toMatch(pattern);
};

/** A pre-tenancy database: migrated to 0020, seeded, then filled with rows nobody owns. */
const legacyDatabase = async (options: { withPreferences?: boolean } = {}): Promise<Db> => {
  const db = await open();
  await migrate(db, { migrationsFolder: preTenancyFolder });
  await seedAsBefore(db);
  if (options.withPreferences ?? true) await seedOwnerSettings(db);
  await seedLegacyData(db);
  await db.run(
    sql`INSERT INTO dashboards (id, name, html, source, path, updated_at, version) VALUES ('dash-mine', 'my board', '<div>mine</div>', 'inline', NULL, '2026-09-01T00:00:00Z', 0)`,
  );
  return db;
};

const reader = (db: Db) => (db as Db & { $client: Parameters<typeof findRowsWithoutKnownUser>[0] }).$client;

describe('migration 0021 — tenancy data', () => {
  it('is listed as data-rewriting, so the safety copy covers it', () => {
    expect(DATA_REWRITING_MIGRATIONS).toContain(TENANCY_MIGRATION_TAG);
  });

  it('assigns every owned row to the owner and leaves the shared defaults shared', async () => {
    const db = await legacyDatabase();
    await bootstrap(db);

    for (const table of OWNED_TABLES) {
      const owners = await db.all<{ user_id: string | null }>(
        sql`SELECT DISTINCT user_id FROM ${sql.identifier(table)}`,
      );
      expect(
        owners.map((r) => r.user_id),
        table,
      ).toEqual(owners.length === 0 ? [] : [OWNER_USER_ID]);
    }

    const categories = await db.all<{ id: string; user_id: string | null }>(sql`SELECT id, user_id FROM categories`);
    const owned = categories
      .filter((c) => c.user_id !== null)
      .map((c) => c.id)
      .sort();
    expect(owned).toEqual(['cat-mine', 'sub-mine', 'sub-under-default']);
    for (const c of categories.filter((row) => owned.includes(row.id) === false)) expect(c.user_id).toBeNull();
    expect(categories.filter((c) => c.user_id === null)).toHaveLength(DefaultCategoryId.options.length);

    const edges = await db.all<{ origin: string; user_id: string | null }>(
      sql`SELECT origin, user_id FROM merchant_category`,
    );
    expect(edges.filter((e) => e.origin === 'history').map((e) => e.user_id)).toEqual([OWNER_USER_ID]);
    expect(edges.filter((e) => e.origin === 'rule').every((e) => e.user_id === null)).toBe(true);
    expect(edges.filter((e) => e.origin === 'rule').length).toBeGreaterThan(50);

    const dashboards = await db.all<{ name: string; source: string; user_id: string | null }>(
      sql`SELECT name, source, user_id FROM dashboards`,
    );
    expect(dashboards.filter((d) => d.source === 'inline')).toEqual([
      { name: 'my board', source: 'inline', user_id: OWNER_USER_ID },
    ]);
    expect(dashboards.filter((d) => d.source === 'file').every((d) => d.user_id === null)).toBe(true);
    expect(dashboards.some((d) => d.source === 'file')).toBe(true);
  });

  it('loses and changes nothing else: every row, tag link, search hit and balance comes through intact', async () => {
    const db = await legacyDatabase();
    const before = await domainDump(db, false);
    const balanceBefore = await db.all(
      sql`SELECT from_account_id, SUM(amount) AS spent FROM transactions WHERE status = 'effective' GROUP BY from_account_id`,
    );
    const ftsBefore = await db.all(sql`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH 'groceries'`);
    expect(ftsBefore).toHaveLength(1);

    await bootstrap(db);

    const after = await domainDump(db, true);
    const beforeWithoutOwner = Object.fromEntries(
      Object.entries(before).map(([table, rows]) => [table, rows.map(({ user_id: _u, ...rest }) => rest)]),
    );
    expect(after['transactions']).toEqual(beforeWithoutOwner['transactions']);
    expect(after['transaction_tags']).toEqual(beforeWithoutOwner['transaction_tags']);
    expect(after['accounts']).toEqual(beforeWithoutOwner['accounts']);
    expect(after['credit_cards']).toEqual(beforeWithoutOwner['credit_cards']);
    expect(after['bills']).toEqual(beforeWithoutOwner['bills']);
    expect(after['tags']).toEqual(beforeWithoutOwner['tags']);
    expect(after['budgets']).toEqual(beforeWithoutOwner['budgets']);
    expect(after['recurring_rules']).toEqual(beforeWithoutOwner['recurring_rules']);
    expect(after['categories']).toEqual(beforeWithoutOwner['categories']);
    expect(after['merchants']).toEqual(beforeWithoutOwner['merchants']);
    expect(after['dashboards']).toEqual(beforeWithoutOwner['dashboards']);
    expect(after['merchant_category']).toEqual(beforeWithoutOwner['merchant_category']);

    expect(await countOf(db, 'transaction_tags')).toBe(3);
    expect(
      await db.all(
        sql`SELECT from_account_id, SUM(amount) AS spent FROM transactions WHERE status = 'effective' GROUP BY from_account_id`,
      ),
    ).toEqual(balanceBefore);
    expect(await db.all(sql`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH 'groceries'`)).toEqual(
      ftsBefore,
    );
    await db.run(
      sql`INSERT INTO transactions (id, description, amount, type, status, date, currency, source, idempotency_key, classification_method, confidence, version, user_id) VALUES ('tx-new', 'Sushi dinner', 10, 'expense', 'effective', '2026-09-05', 'USD', 'mcp', 'k-new', 'none', 0, 0, ${OWNER_USER_ID})`,
    );
    expect(await db.all(sql`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH 'sushi'`)).toHaveLength(1);
    await db.run(sql`UPDATE transactions SET description = 'Sushi lunch' WHERE id = 'tx-new'`);
    expect(await db.all(sql`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH 'dinner'`)).toHaveLength(0);
    await db.run(sql`DELETE FROM transactions WHERE id = 'tx-new'`);
    expect(await db.all(sql`SELECT rowid FROM transactions_fts WHERE transactions_fts MATCH 'sushi'`)).toHaveLength(0);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('moves the singleton preferences to the owner and empties the instance settings', async () => {
    const db = await legacyDatabase();
    await bootstrap(db);

    expect(await db.all(sql`SELECT user_id, locale, locale_source, base_currency, version FROM user_settings`)).toEqual(
      [{ user_id: OWNER_USER_ID, locale: 'pt', locale_source: 'explicit', base_currency: 'BRL', version: 2 }],
    );
    // The sign-in cap (0022), instance kind (0025), demo completion (0026) and demo country (0027) are the
    // singleton's only settings; its old preferences are gone.
    expect(await db.all(sql`SELECT name FROM pragma_table_info('settings') ORDER BY cid`)).toEqual([
      { name: 'id' },
      { name: 'version' },
      { name: 'max_sign_in_duration' },
      { name: 'instance_kind' },
      { name: 'demo_seeded_at' },
      { name: 'demo_country' },
    ]);
    expect(await countOf(db, 'settings')).toBe(1);
  });

  it('gives a database that never stored preferences no user_settings row (defaults apply)', async () => {
    const db = await legacyDatabase({ withPreferences: false });
    await db.run(sql`DELETE FROM settings`);
    await bootstrap(db);
    expect(await countOf(db, 'user_settings')).toBe(0);
  });

  it('writes a restricted backup of the pre-migration database before changing anything', async () => {
    const db = await legacyDatabase();
    await bootstrap(db);

    const backup = backupPath(dbPath, TENANCY_MIGRATION_TAG);
    expect(backup).toBe(`${dbPath}.pre-${TENANCY_MIGRATION_TAG}.bak`);
    expect(existsSync(backup)).toBe(true);
    expect(statSync(backup).mode & 0o077).toBe(0);

    // The backup is the database as it was: it opens with the same key and has no user_id anywhere.
    const copy = await openDatabase({
      KEY_LOCK_PATH: keyLockPathForTest(),
      DB_PATH: backup,
      FINTRACK_DB_KEY: TEST_KEY,
    });
    expect(await countOf(copy, 'transactions')).toBe(2);
    expect(await copy.all(sql`SELECT name FROM pragma_table_info('transactions') WHERE name = 'user_id'`)).toEqual([]);
  });

  it('takes no backup for a brand-new database', async () => {
    const db = await open();
    await bootstrap(db);
    expect(existsSync(backupPath(dbPath, TENANCY_MIGRATION_TAG))).toBe(false);
    expect(await findRowsWithoutKnownUser(reader(db))).toEqual({});
  });

  it('refuses a database whose owner is missing, rolls everything back and writes nothing', async () => {
    const db = await legacyDatabase();
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.run(sql`DELETE FROM users WHERE id = ${OWNER_USER_ID}`);
    const before = await domainDump(db, false);

    await expect(bootstrap(db)).rejects.toThrow();

    expect(await domainDump(db, false)).toEqual(before);
    expect(await db.all(sql`SELECT name FROM pragma_table_info('accounts') WHERE name = 'user_id'`)).toEqual([]);
    expect(await db.all(sql`SELECT name FROM sqlite_master WHERE name = 'user_settings'`)).toEqual([]);
  });

  describe('the integrity check (§7)', () => {
    it('passes on a migrated database', async () => {
      const db = await legacyDatabase();
      await bootstrap(db);
      await expect(assertOwnedRowsHaveKnownUsers(reader(db))).resolves.toBeUndefined();
    });

    it('names every table holding a row with no owner or an unknown one', async () => {
      const db = await legacyDatabase();
      await bootstrap(db);
      await db.run(sql`PRAGMA foreign_keys = OFF`);
      await db.run(sql`UPDATE accounts SET user_id = 'ghost' WHERE id = 'acc-1'`);
      await db.run(sql`UPDATE categories SET user_id = 'ghost' WHERE id = 'cat-mine'`);
      await db.run(sql`UPDATE user_settings SET user_id = 'ghost'`);

      expect(await findRowsWithoutKnownUser(reader(db))).toEqual({
        accounts: 1,
        categories: 1,
        user_settings: 1,
      });
      await expect(assertOwnedRowsHaveKnownUsers(reader(db))).rejects.toThrow(
        /refusing to start.*accounts: 1.*categories: 1.*user_settings: 1/,
      );
    });
  });

  describe('the integrity check covers every table that has an owner column', () => {
    const tablesWithUserId = () =>
      Object.values(schema)
        .filter((table) => is(table, SQLiteTable))
        .map((table) => getTableConfig(table as SQLiteTable))
        .filter((config) => config.columns.some((column) => column.name === 'user_id'))
        .map((config) => config.name);
    // Identity tables also have a user_id (a login's owner, not tenancy) and are not tenant data.
    const IDENTITY = ['sessions', 'access_tokens', 'client_grants', 'invites'];

    it('lists exactly the schema’s tenant tables, so a new owned table cannot be forgotten', () => {
      const listed = [...OWNED_TABLES, ...SHARED_OR_OWNED_TABLES, 'user_settings'].sort();
      expect(
        tablesWithUserId()
          .filter((name) => !IDENTITY.includes(name))
          .sort(),
      ).toEqual(listed);
    });

    it('flags a user’s category that became shared (owner missing at backfill), not a seeded default', async () => {
      const db = await open();
      await bootstrap(db);
      expect(await findRowsWithoutKnownUser(reader(db))).toEqual({});
      await db.run(sql`INSERT INTO categories (id, name, kind, user_id) VALUES ('cat-mine', 'Mine', 'expense', NULL)`);
      expect(await findRowsWithoutKnownUser(reader(db))).toEqual({ categories: 1 });
    });
  });

  describe('uniqueness with NULLs (SQLite treats them as distinct in a UNIQUE index)', () => {
    const SECOND_USER = 'user-second';

    const migrated = async (): Promise<Db> => {
      const db = await open();
      await bootstrap(db);
      await db.run(
        sql`INSERT INTO users (id, username, password_hash, role, created_at, version) VALUES (${SECOND_USER}, 'second', 'x', 'member', '2026-01-01T00:00:00Z', 0)`,
      );
      return db;
    };

    it('lets two users hold a tag of the same name, but not one user twice', async () => {
      const db = await migrated();
      await db.run(sql`INSERT INTO tags (id, name, version, user_id) VALUES ('t1', 'trip', 0, ${OWNER_USER_ID})`);
      await db.run(sql`INSERT INTO tags (id, name, version, user_id) VALUES ('t2', 'trip', 0, ${SECOND_USER})`);
      await rejectsWith(
        db.run(sql`INSERT INTO tags (id, name, version, user_id) VALUES ('t3', 'trip', 0, ${OWNER_USER_ID})`),
        /UNIQUE/,
      );
    });

    it('dedups a transaction per user, so the same statement imports for each', async () => {
      const db = await migrated();
      const insert = (id: string, user: string) =>
        db.run(
          sql`INSERT INTO transactions (id, description, amount, type, status, date, currency, source, idempotency_key, classification_method, confidence, version, user_id) VALUES (${id}, 'x', 1, 'expense', 'effective', '2026-09-01', 'USD', 'import', 'same-key', 'none', 0, 0, ${user})`,
        );
      await insert('a', OWNER_USER_ID);
      await insert('b', SECOND_USER);
      await rejectsWith(insert('c', OWNER_USER_ID), /UNIQUE/);
    });

    it('keeps one budget per (user, category, currency, period)', async () => {
      const db = await migrated();
      const insert = (id: string, user: string) =>
        db.run(
          sql`INSERT INTO budgets (id, category_id, currency, limit_amount, period, version, user_id) VALUES (${id}, 'cat-food', 'USD', 10, 'monthly', 0, ${user})`,
        );
      await insert('b1', OWNER_USER_ID);
      await insert('b2', SECOND_USER);
      await rejectsWith(insert('b3', OWNER_USER_ID), /UNIQUE/);
    });

    it('keeps shared dashboards unique by name even though their user_id is NULL', async () => {
      const db = await migrated();
      const insertShared = (id: string, name: string) =>
        db.run(
          sql`INSERT INTO dashboards (id, name, html, source, path, updated_at, version, user_id) VALUES (${id}, ${name}, NULL, 'file', 'x.html', 'now', 0, NULL)`,
        );
      await insertShared('s1', 'brand-new-default');
      await rejectsWith(insertShared('s2', 'brand-new-default'), /UNIQUE/);
    });

    it('lets a user save a dashboard under a default’s name, once, and another user do the same', async () => {
      const db = await migrated();
      const insertOwn = (id: string, user: string) =>
        db.run(
          sql`INSERT INTO dashboards (id, name, html, source, path, updated_at, version, user_id) VALUES (${id}, 'overview', '<p/>', 'inline', NULL, 'now', 0, ${user})`,
        );
      await insertOwn('d1', OWNER_USER_ID);
      await insertOwn('d2', SECOND_USER);
      await rejectsWith(insertOwn('d3', OWNER_USER_ID), /UNIQUE/);
    });

    it('refuses a shared inline dashboard and an owned file dashboard', async () => {
      const db = await migrated();
      await rejectsWith(
        db.run(
          sql`INSERT INTO dashboards (id, name, html, source, path, updated_at, version, user_id) VALUES ('x1', 'n', '<p/>', 'inline', NULL, 'now', 0, NULL)`,
        ),
        /CHECK/,
      );
      await rejectsWith(
        db.run(
          sql`INSERT INTO dashboards (id, name, html, source, path, updated_at, version, user_id) VALUES ('x2', 'n2', NULL, 'file', 'a.html', 'now', 0, ${OWNER_USER_ID})`,
        ),
        /CHECK/,
      );
    });

    it('keeps one merchant edge per audience: shared rules unique among themselves, history per user', async () => {
      const db = await migrated();
      await db.run(sql`INSERT OR IGNORE INTO merchants (key) VALUES ('padoca-nova')`);
      const insertRule = () =>
        db.run(
          sql`INSERT INTO merchant_category (merchant_key, category_id, weight, origin, user_id) VALUES ('padoca-nova', 'cat-food', 3, 'rule', NULL)`,
        );
      const insertHistory = (user: string) =>
        db.run(
          sql`INSERT INTO merchant_category (merchant_key, category_id, weight, origin, user_id) VALUES ('padoca-nova', 'cat-food', 1, 'history', ${user})`,
        );
      await insertRule();
      await rejectsWith(insertRule(), /UNIQUE/);
      await insertHistory(OWNER_USER_ID);
      await insertHistory(SECOND_USER);
      await rejectsWith(insertHistory(OWNER_USER_ID), /UNIQUE/);
    });

    it('refuses a shared history edge and an owned rule edge', async () => {
      const db = await migrated();
      await db.run(sql`INSERT OR IGNORE INTO merchants (key) VALUES ('livraria-nova')`);
      await rejectsWith(
        db.run(
          sql`INSERT INTO merchant_category (merchant_key, category_id, weight, origin, user_id) VALUES ('livraria-nova', 'cat-food', 1, 'history', NULL)`,
        ),
        /CHECK/,
      );
      await rejectsWith(
        db.run(
          sql`INSERT INTO merchant_category (merchant_key, category_id, weight, origin, user_id) VALUES ('livraria-nova', 'cat-food', 1, 'rule', ${OWNER_USER_ID})`,
        ),
        /CHECK/,
      );
    });

    it('refuses to delete a user who still owns data (ON DELETE RESTRICT)', async () => {
      const db = await migrated();
      await db.run(sql`INSERT INTO tags (id, name, version, user_id) VALUES ('t1', 'trip', 0, ${SECOND_USER})`);
      await rejectsWith(db.run(sql`DELETE FROM users WHERE id = ${SECOND_USER}`), /FOREIGN KEY/);
    });
  });

  it('lists exactly the seeded defaults as shared (the ids the migration names are all still seeded)', () => {
    const named = [...readFileSync(MIGRATION_FILE, 'utf8').matchAll(/'(cat-[a-z-]+)'/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(DefaultCategoryId.options));
  });
});
