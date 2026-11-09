import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { backupPath } from '../../../src/diplomat/db/safety-copy.js';
import { isUniqueConstraintViolation } from '../../../src/diplomat/db/sqlite-errors.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

const TEST_KEY = 'f'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const MIGRATION_TAG = '0022_user_management';

let tmpDir: string;
let dbPath: string;
let beforeFolder: string;

/** A copy of the real migrations whose journal stops just before this one: a database as the last release left it. */
const journalBefore = (folder: string, tag = MIGRATION_TAG): void => {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === tag);
  if (cutoff === -1) throw new Error(`${tag} not in ${journalPath}`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
};

const open = () => openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, PATTY_DB_KEY: TEST_KEY });

/** A pre-migration database in which the owner has claimed the instance and a stdio sign-in exists. */
const previousRelease = async (): Promise<Db> => {
  const db = await open();
  await migrate(db, { migrationsFolder: beforeFolder });
  await db.run(
    sql`INSERT INTO settings (id, version) VALUES ('singleton', 4) ON CONFLICT (id) DO UPDATE SET version = 4`,
  );
  await db.run(
    sql`UPDATE users SET username = 'rafael', password_hash = '$argon2id$stub', version = 2 WHERE id = ${OWNER_USER_ID}`,
  );
  await db.run(
    sql`INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, version) VALUES ('s1', ${OWNER_USER_ID}, 'sha', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z', 0)`,
  );
  return db;
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-user-management-migration-'));
  dbPath = join(tmpDir, 'patty.db');
  beforeFolder = join(tmpDir, 'before-migrations');
  cpSync(REAL_MIGRATIONS_FOLDER, beforeFolder, { recursive: true });
  journalBefore(beforeFolder);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0022 — user management', () => {
  it('only adds structure: it is not data-rewriting, so no safety copy is taken', async () => {
    expect(DATA_REWRITING_MIGRATIONS).not.toContain(MIGRATION_TAG);
    const db = await previousRelease();
    await bootstrap(db);

    expect(existsSync(backupPath(dbPath, MIGRATION_TAG))).toBe(false);
    expect(readdirSync(tmpDir).filter((name) => name.endsWith('.bak') && name.includes(MIGRATION_TAG))).toEqual([]);
  });

  it('keeps every user, session and the instance row, adding only a null last login and the 30-day cap', async () => {
    const db = await previousRelease();
    const usersBefore = await db.all(sql`SELECT id, username, password_hash, role, disabled_at, version FROM users`);
    await bootstrap(db);

    expect(await db.all(sql`SELECT id, username, password_hash, role, disabled_at, version FROM users`)).toEqual(
      usersBefore,
    );
    expect(await db.all(sql`SELECT last_login_at FROM users`)).toEqual([{ last_login_at: null }]);
    expect(await db.all(sql`SELECT id FROM sessions`)).toEqual([{ id: 's1' }]);
    expect(await db.all(sql`SELECT id, max_sign_in_duration, version FROM settings`)).toEqual([
      { id: 'singleton', max_sign_in_duration: '30d', version: 4 },
    ]);
    expect(await db.all(sql`SELECT * FROM invites`)).toEqual([]);
  });

  describe('the invites table', () => {
    const addUser = (db: Db, id: string) =>
      db.run(
        sql`INSERT INTO users (id, username, role, created_at, version) VALUES (${id}, ${id}, 'member', '2026-10-01T00:00:00Z', 0)`,
      );
    const addInvite = (
      db: Db,
      id: string,
      userId: string,
      usedAt: string | null = null,
      createdBy: string | null = null,
    ) =>
      db.run(
        sql`INSERT INTO invites (id, user_id, code_hash, created_by, created_at, expires_at, used_at, version) VALUES (${id}, ${userId}, ${`hash-${id}`}, ${createdBy}, '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z', ${usedAt}, 0)`,
      );

    it('allows one unclaimed invite per user and any number of spent ones', async () => {
      const db = await previousRelease();
      await bootstrap(db);
      await addUser(db, 'ana');

      await addInvite(db, 'i1', 'ana', '2026-10-02T00:00:00Z');
      await addInvite(db, 'i2', 'ana', '2026-10-03T00:00:00Z');
      await addInvite(db, 'i3', 'ana');
      expect(isUniqueConstraintViolation(await addInvite(db, 'i4', 'ana').catch((e: unknown) => e))).toBe(true);
    });

    it('keys an invite by the hash of its code: the same hash cannot be stored twice', async () => {
      const db = await previousRelease();
      await bootstrap(db);
      await addUser(db, 'ana');
      await addUser(db, 'bob');
      await addInvite(db, 'i1', 'ana');
      const duplicate = await db
        .run(
          sql`INSERT INTO invites (id, user_id, code_hash, created_at, expires_at, version) VALUES ('i2', 'bob', 'hash-i1', 'x', 'y', 0)`,
        )
        .catch((e: unknown) => e);
      expect(isUniqueConstraintViolation(duplicate)).toBe(true);
    });

    it('restricts deleting a user an invite refers to, as invitee or issuer (users are never deleted)', async () => {
      const db = await previousRelease();
      await bootstrap(db);
      await addUser(db, 'ana');
      await addInvite(db, 'i1', 'ana', null, OWNER_USER_ID);

      // SQLite reports a RESTRICT as a trigger-style constraint failure, so assert on what matters: it refuses.
      await expect(db.run(sql`DELETE FROM users WHERE id = 'ana'`)).rejects.toMatchObject({
        cause: { code: 'SQLITE_CONSTRAINT' },
      });
      await expect(db.run(sql`DELETE FROM users WHERE id = ${OWNER_USER_ID}`)).rejects.toMatchObject({
        cause: { code: 'SQLITE_CONSTRAINT' },
      });
      expect(await db.all(sql`SELECT id FROM users WHERE id IN ('ana', ${OWNER_USER_ID}) ORDER BY id`)).toHaveLength(2);
    });

    it('accepts an invite issued by the terminal, which acts as no user', async () => {
      const db = await previousRelease();
      await bootstrap(db);
      await addUser(db, 'ana');
      await addInvite(db, 'i1', 'ana', null, null);
      expect(await db.all(sql`SELECT created_by FROM invites`)).toEqual([{ created_by: null }]);
    });
  });
});

describe('migration 0023 — the instance settings row', () => {
  const SETTINGS_TAG = '0023_instance_settings_row';
  const settingsRows = (db: Db) => db.all(sql`SELECT id, max_sign_in_duration, version FROM settings`);

  it('is not data-rewriting, and inserts exactly one default row into a database without one', async () => {
    expect(DATA_REWRITING_MIGRATIONS).not.toContain(SETTINGS_TAG);
    const db = await previousRelease();
    await db.run(sql`DELETE FROM settings`);
    await bootstrap(db);
    expect(await settingsRows(db)).toEqual([{ id: 'singleton', max_sign_in_duration: '30d', version: 0 }]);
  });

  it('keeps a row an admin already saved, and is idempotent when replayed', async () => {
    // A journal that ends at 0023 itself, so the replay below is 0023 and nothing newer.
    const upTo0023 = join(tmpDir, 'up-to-0023');
    cpSync(REAL_MIGRATIONS_FOLDER, upTo0023, { recursive: true });
    journalBefore(upTo0023, '0024_credentials_changed_at');
    const db = await previousRelease();
    await migrate(db, { migrationsFolder: upTo0023 });
    await db.run(sql`UPDATE settings SET max_sign_in_duration = '7d', version = 5`);
    await db.run(sql`DELETE FROM __drizzle_migrations WHERE id = (SELECT MAX(id) FROM __drizzle_migrations)`);
    await migrate(db, { migrationsFolder: upTo0023 });
    expect(await settingsRows(db)).toEqual([{ id: 'singleton', max_sign_in_duration: '7d', version: 5 }]);
  });
});

describe('migration 0024 — credentials_changed_at', () => {
  const CHANGED_TAG = '0024_credentials_changed_at';

  it('adds a nullable column, is not data-rewriting, and leaves every existing user unstamped', async () => {
    expect(DATA_REWRITING_MIGRATIONS).not.toContain(CHANGED_TAG);
    const db = await previousRelease();
    await bootstrap(db);
    expect(await db.all(sql`SELECT id, credentials_changed_at FROM users`)).toEqual([
      { id: OWNER_USER_ID, credentials_changed_at: null },
    ]);
  });
});
