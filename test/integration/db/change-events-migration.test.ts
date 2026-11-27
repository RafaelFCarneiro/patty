import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';
import { migrationsBefore } from '../fixtures/migrations-before.js';

const TEST_KEY = 'f'.repeat(64);
const MIGRATION_TAG = '0029_change_events';

let tmpDir: string;
let dbPath: string;

const open = () => openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, PATTY_DB_KEY: TEST_KEY });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-change-events-migration-'));
  dbPath = join(tmpDir, 'patty.db');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0029 — change_events (ADR-036 §1)', () => {
  it('only adds a table, so no safety copy is taken', async () => {
    expect(DATA_REWRITING_MIGRATIONS).not.toContain(MIGRATION_TAG);
    const db = await open();
    await migrate(db, { migrationsFolder: migrationsBefore(tmpDir, MIGRATION_TAG) });

    await bootstrap(db);

    // Later data-rewriting migrations take their own copy on the way to the latest schema; 0029 takes none.
    expect(readdirSync(tmpDir).filter((name) => name.endsWith(`.pre-${MIGRATION_TAG}.bak`))).toEqual([]);
    expect(existsSync(`${dbPath}.pre-${MIGRATION_TAG}.bak`)).toBe(false);
  });

  it('creates the table and its index on an existing database without touching its data', async () => {
    const db = await open();
    await migrate(db, { migrationsFolder: migrationsBefore(tmpDir, MIGRATION_TAG) });
    await db.run(sql`UPDATE settings SET max_sign_in_duration = '7d', version = 9 WHERE id = 'singleton'`);
    expect(await db.all(sql`SELECT name FROM sqlite_master WHERE name = 'change_events'`)).toEqual([]);
    // The seed (categories…) is bootstrap's, not the migration's: what existed before is exactly what exists after.
    const before = {
      settings: await db.all(sql`SELECT * FROM settings`),
      users: await db.all(sql`SELECT * FROM users`),
    };

    await bootstrap(db);

    expect(await db.all(sql`SELECT name FROM sqlite_master WHERE name = 'change_events'`)).toHaveLength(1);
    expect(
      await db.all<{ name: string; type: string; notnull: number }>(
        sql`SELECT name, type, "notnull" FROM pragma_table_info('change_events') ORDER BY cid`,
      ),
    ).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 1 },
      { name: 'user_id', type: 'TEXT', notnull: 0 },
      { name: 'entities', type: 'TEXT', notnull: 1 },
      { name: 'origin', type: 'TEXT', notnull: 1 },
      { name: 'created_at', type: 'TEXT', notnull: 1 },
    ]);
    expect(await db.all(sql`SELECT name FROM pragma_index_list('change_events')`)).toEqual([
      { name: 'change_events_created_at_idx' },
    ]);
    expect(await db.all(sql`SELECT COUNT(*) AS n FROM change_events`)).toEqual([{ n: 0 }]);
    expect({
      settings: await db.all(sql`SELECT * FROM settings`),
      users: await db.all(sql`SELECT * FROM users`),
    }).toEqual(before);
  });
});
