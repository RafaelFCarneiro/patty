import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { currenciesRepo } from '../../../src/diplomat/db/repos/currencies.js';

const TEST_KEY = 'c'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const MIGRATION_0015_TAG = '0015_currencies_decimals';

let tmpDir: string;
let dbPath: string;
let preMigrationFolder: string;

/** Rewrites `folder`'s journal in place, keeping only entries strictly before `MIGRATION_0015_TAG`
 *  — same technique as `dashboardIdMigration.test.ts`'s `truncateJournalBefore0011`. */
const truncateJournalBefore0015 = (folder: string): void => {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === MIGRATION_0015_TAG);
  if (cutoff === -1) throw new Error(`${MIGRATION_0015_TAG} not found in ${journalPath} — has it been renamed?`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-currencies-migration-'));
  dbPath = join(tmpDir, 'migration.db');

  // A copy of the real migrations folder with 0015's journal entry (and everything after) removed
  // — simulating a DB that predates the `decimals` column, i.e. any real install upgrading from
  // before ADR-026 Phase 1, with pre-existing BRL/USD rows (not just freshly-seeded ones).
  preMigrationFolder = join(tmpDir, 'pre-0015-migrations');
  cpSync(REAL_MIGRATIONS_FOLDER, preMigrationFolder, { recursive: true });
  truncateJournalBefore0015(preMigrationFolder);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const openOpts = () => ({
  DB_PATH: dbPath,
  FINTRACK_DB_KEY: TEST_KEY,
  PORT: 3001,
  MCP_TRANSPORT: McpTransport.enum.http,
  FINTRACK_HTTP: true,
});

describe('migration 0015 — currencies.decimals backfill (ADR-026 Phase 1)', () => {
  it('backfills decimals=2 on a pre-existing BRL/USD row, not just freshly-seeded currencies', async () => {
    const db = await openDatabase(openOpts());
    await migrate(db, { migrationsFolder: preMigrationFolder });

    // A pre-0015 row has no `decimals` column at all — matches migration 0000's original schema.
    await db.run(sql`INSERT INTO currencies (code, symbol, name) VALUES ('BRL', 'R$', 'Real Brasileiro')`);
    await db.run(sql`INSERT INTO currencies (code, symbol, name) VALUES ('USD', '$', 'US Dollar')`);

    // The rest of the head migrations, including 0015 itself — proving the backfill applies to a
    // row that existed before the column did, not only to rows inserted after.
    await migrate(db, { migrationsFolder: REAL_MIGRATIONS_FOLDER });

    const rows = await db.all<{ code: string; decimals: number }>(
      sql`SELECT code, decimals FROM currencies WHERE code IN ('BRL', 'USD') ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: 'BRL', decimals: 2 },
      { code: 'USD', decimals: 2 },
    ]);

    // Reading through the real repo/adapter path (not just raw SQL) confirms the backfilled value
    // round-trips through CurrencySchema validation too.
    const repo = currenciesRepo(db);
    const currencies = await repo.list();
    expect(currencies.find((c) => c.code === 'BRL')).toEqual({
      code: 'BRL',
      symbol: 'R$',
      name: 'Real Brasileiro',
      decimals: 2,
    });
  });
});
