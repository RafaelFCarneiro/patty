import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { backupPath } from '../../../src/diplomat/db/safety-copy.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';
import { migrationsBefore } from '../fixtures/migrations-before.js';

const TEST_KEY = 'd'.repeat(64);
const MIGRATION_TAG = '0032_partial_bill_payment';

let tmpDir: string;
let dbPath: string;

const open = () => openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, PATTY_DB_KEY: TEST_KEY });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-partial-bill-payment-migration-'));
  dbPath = join(tmpDir, 'patty.db');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

const transferInsert = (id: string, billId: string | null) =>
  sql`INSERT INTO transactions (id, description, amount, type, status, date, currency, source, idempotency_key, classification_method, confidence, from_account_id, to_account_id, bill_id, user_id, version)
      VALUES (${id}, 'Bill payment', 100, 'transfer', 'effective', '2026-09-25', 'USD', 'mcp', ${`billpay-${id}`}, 'none', 0, 'acc-1', 'acc-card', ${billId}, ${OWNER_USER_ID}, 0)`;

/** What a release before Feature Design 025 leaves: a paid bill whose payment transfer it points at, one
 *  transfer already carrying the bill, and one known only through the column the migration drops. */
const seedLegacyPaidBills = async (db: Db): Promise<void> => {
  const run = (statement: ReturnType<typeof sql>) => db.run(statement);
  await run(sql`INSERT OR IGNORE INTO currencies (code, symbol, name, decimals) VALUES ('USD', '$', 'US Dollar', 2)`);
  await run(
    sql`INSERT INTO accounts (id, name, type, initial_balance, currency, user_id, version) VALUES ('acc-1', 'Checking', 'checking', 1000, 'USD', ${OWNER_USER_ID}, 0)`,
  );
  await run(
    sql`INSERT INTO accounts (id, name, type, initial_balance, currency, user_id, version) VALUES ('acc-card', 'Card: Visa', 'credit', 0, 'USD', ${OWNER_USER_ID}, 0)`,
  );
  await run(
    sql`INSERT INTO credit_cards (id, name, closing_day, due_day, currency, account_id, payment_account_id, user_id, version) VALUES ('card-1', 'Visa', 10, 20, 'USD', 'acc-card', 'acc-1', ${OWNER_USER_ID}, 0)`,
  );
  await run(
    sql`INSERT INTO bills (id, credit_card_id, month, year, close_date, due_date, status, user_id, version) VALUES ('bill-linked', 'card-1', 8, 2026, '2026-08-10', '2026-08-20', 'paid', ${OWNER_USER_ID}, 3)`,
  );
  await run(
    sql`INSERT INTO bills (id, credit_card_id, month, year, close_date, due_date, status, user_id, version) VALUES ('bill-pointer-only', 'card-1', 9, 2026, '2026-09-10', '2026-09-20', 'paid', ${OWNER_USER_ID}, 3)`,
  );
  await run(transferInsert('pay-linked', 'bill-linked'));
  await run(transferInsert('pay-pointer-only', null));
  await run(sql`UPDATE bills SET payment_transaction_id = 'pay-linked' WHERE id = 'bill-linked'`);
  await run(sql`UPDATE bills SET payment_transaction_id = 'pay-pointer-only' WHERE id = 'bill-pointer-only'`);
};

describe('migration 0032 — partial bill payment (Feature Design 025)', () => {
  it('is listed as data-rewriting, so the database is copied aside first', async () => {
    expect(DATA_REWRITING_MIGRATIONS).toContain(MIGRATION_TAG);
    const db = await open();
    await migrate(db, { migrationsFolder: migrationsBefore(tmpDir, MIGRATION_TAG) });
    await seedLegacyPaidBills(db);

    await bootstrap(db);

    expect(existsSync(backupPath(dbPath, MIGRATION_TAG))).toBe(true);
  });

  it('drops the payment pointer, keeps every bill, and links every payment transfer to its bill', async () => {
    const db = await open();
    await migrate(db, { migrationsFolder: migrationsBefore(tmpDir, MIGRATION_TAG) });
    await seedLegacyPaidBills(db);

    await bootstrap(db);

    expect(
      (await db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('bills')`)).map((c) => c.name),
    ).not.toContain('payment_transaction_id');
    expect(await db.all(sql`SELECT id, credit_card_id, month, year, status, version FROM bills ORDER BY id`)).toEqual([
      { id: 'bill-linked', credit_card_id: 'card-1', month: 8, year: 2026, status: 'paid', version: 3 },
      { id: 'bill-pointer-only', credit_card_id: 'card-1', month: 9, year: 2026, status: 'paid', version: 3 },
    ]);
    expect(await db.all(sql`SELECT id, bill_id FROM transactions WHERE type = 'transfer' ORDER BY id`)).toEqual([
      { id: 'pay-linked', bill_id: 'bill-linked' },
      { id: 'pay-pointer-only', bill_id: 'bill-pointer-only' },
    ]);
  });

  it('keeps the unique cycle index and the bill foreign keys', async () => {
    const db = await open();
    await migrate(db, { migrationsFolder: migrationsBefore(tmpDir, MIGRATION_TAG) });
    await seedLegacyPaidBills(db);

    await bootstrap(db);

    expect(await db.all(sql`SELECT name FROM pragma_index_list('bills') WHERE "unique" = 1 AND origin = 'c'`)).toEqual([
      { name: 'bills_card_month_year' },
    ]);
    expect(
      (await db.all<{ table: string }>(sql`SELECT "table" FROM pragma_foreign_key_list('bills')`))
        .map((f) => f.table)
        .sort(),
    ).toEqual(['credit_cards', 'users']);
  });
});
