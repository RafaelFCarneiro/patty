import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseAheadCode } from '../../../src/models/database.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { MIGRATIONS_TABLE } from '../../../src/diplomat/db/migration-barrier.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

/**
 * Two builds starting together: the older one passes the guard, the newer one then commits a migration, and the older
 * one must NOT go on to seed. The newer build's commit is simulated by a migration this build runs that stamps a row
 * newer than anything its journal ships into the migrations table — exactly what the other build's migrator leaves.
 */
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const FAR_FUTURE_MS = 10 * 365 * 24 * 3600 * 1000;

let dir = '';
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-guard-race-'));
  db = await openDatabase({
    KEY_LOCK_PATH: keyLockPathForTest(),
    DB_PATH: join(dir, 'fintrack.db'),
    FINTRACK_DB_KEY: 'e'.repeat(64),
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe('the version guard is re-checked before seeding', () => {
  it('refuses, and seeds nothing, when a newer build migrated while this one was starting', async () => {
    const folder = join(dir, 'racing-migrations');
    cpSync(REAL_MIGRATIONS_FOLDER, folder, { recursive: true });
    const [first] = readdirSync(folder)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    appendFileSync(
      join(folder, first!),
      `\n--> statement-breakpoint\nINSERT INTO "${MIGRATIONS_TABLE}" (hash, created_at) VALUES ('newer-build', ${Date.now() + FAR_FUTURE_MS});`,
    );

    expect((await bootstrap(db, folder))._unsafeUnwrapErr().code).toBe(DatabaseAheadCode.enum.database_ahead);

    expect(await db.all(sql`SELECT 1 FROM currencies`)).toEqual([]); // never seeded
  });
});
