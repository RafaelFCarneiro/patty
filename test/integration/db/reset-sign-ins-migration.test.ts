import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { accessTokensRepo } from '../../../src/diplomat/db/repos/access-tokens.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';
import { migrationsBefore } from '../fixtures/migrations-before.js';

const TEST_KEY = 'f'.repeat(64);
const MIGRATION_TAG = '0028_reset_sign_ins';
const UNKNOWN_SCOPE = 'legacy:read';

let tmpDir: string;
let dbPath: string;
let beforeFolder: string;

const open = () => openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, PATTY_DB_KEY: TEST_KEY });

const seedSignIns = async (db: Awaited<ReturnType<typeof open>>): Promise<void> => {
  await db.run(sql`INSERT INTO access_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, kind)
    VALUES ('tok-1', ${OWNER_USER_ID}, 'laptop', 'hash-1', 'abcd', ${JSON.stringify([UNKNOWN_SCOPE])}, '2026-01-01T00:00:00Z', 'pat')`);
  await db.run(sql`INSERT INTO client_grants (id, device_code_hash, user_code, client_name, client_version, profile, status, scopes, created_at, expires_at)
    VALUES ('grant-1', 'dev-hash-1', 'ABCD-EFGH', 'client', '1', 'default', 'approved', ${JSON.stringify([UNKNOWN_SCOPE])}, '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z')`);
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-reset-sign-ins-migration-'));
  dbPath = join(tmpDir, 'patty.db');
  beforeFolder = migrationsBefore(tmpDir, MIGRATION_TAG);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0028 — reset sign-ins', () => {
  it('is data-rewriting, so a safety copy is taken first', () => {
    expect(DATA_REWRITING_MIGRATIONS).toContain(MIGRATION_TAG);
  });

  it('empties tokens and grants whatever scopes they hold, and the token list loads empty', async () => {
    const db = await open();
    await migrate(db, { migrationsFolder: beforeFolder });
    await seedSignIns(db);
    await expect(accessTokensRepo(db).listByUser(OWNER_USER_ID)).rejects.toThrow();

    await bootstrap(db);

    expect(await accessTokensRepo(db).listByUser(OWNER_USER_ID)).toEqual([]);
    expect(await db.all(sql`SELECT id FROM client_grants`)).toEqual([]);
    expect(existsSync(`${dbPath}.pre-${MIGRATION_TAG}.bak`)).toBe(true);
  });

  it('keeps users: only the ways in are reset', async () => {
    const db = await open();
    await migrate(db, { migrationsFolder: beforeFolder });
    await seedSignIns(db);

    await bootstrap(db);

    expect(await db.all(sql`SELECT id FROM users WHERE id = ${OWNER_USER_ID}`)).toHaveLength(1);
  });
});
