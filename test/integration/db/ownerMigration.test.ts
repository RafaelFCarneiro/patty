import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { BUSY_TIMEOUT_MS, openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { applyPendingMigrationsHolding, MIGRATIONS_TABLE } from '../../../src/diplomat/db/migrationBarrier.js';
import { backupPath } from '../../../src/diplomat/db/safetyCopy.js';
import { OWNER_USER_ID } from '../../../src/models/auth.js';

const TEST_KEY = 'd'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const AUTH_MIGRATION_TAG = '0018_auth_identity';
// A distinctive string written into a domain row before migrating: it must be findable in the bytes of a
// PLAINTEXT database and absent from an encrypted one.
const MARKER = 'PLAINTEXT-MARKER-4f9c2e71';
const SQLITE_PLAINTEXT_HEADER = Buffer.from('SQLite format 3\0');

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
const EXCLUDED_TABLES = /^(__drizzle|sqlite_|transactions_fts|users$|sessions$|access_tokens$|setup_codes$)/;

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
        VALUES ('tx-1', 'Groceries ${sql.raw(MARKER)}', 42.5, 'expense', 'effective', '2026-09-01', 'USD', 'mcp', 'legacy-readable-key', 'rule', 0.8, 'acc-1', 'cat-food', 1)`,
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
    expect(await legacy.all(sql`SELECT * FROM access_tokens`)).toEqual([]);
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

  it('snapshots committed rows another connection wrote that are still only in the WAL', async () => {
    const legacy = await open();
    await bootstrap(legacy, preAuthFolder);
    await seedDomainData(legacy);
    const otherProcess = await open();
    await otherProcess.run(
      sql`INSERT INTO accounts (id, name, type, initial_balance, currency, version) VALUES ('acc-late', 'Late', 'wallet', 5, 'USD', 0)`,
    );

    await bootstrap(legacy);

    const restored = await openDatabase({ DB_PATH: backupPath(dbPath, AUTH_MIGRATION_TAG), FINTRACK_DB_KEY: TEST_KEY });
    const ids = await restored.all<{ id: string }>(sql`SELECT id FROM accounts ORDER BY id`);
    expect(ids.map(({ id }) => id)).toEqual(['acc-1', 'acc-2', 'acc-late']);
  });

  describe('encryption at rest — proven on the raw bytes, not inferred from a wrong key failing', () => {
    const rawBytes = (path: string): Buffer => readFileSync(path);
    const startsWithPlaintextHeader = (bytes: Buffer): boolean =>
      bytes.subarray(0, SQLITE_PLAINTEXT_HEADER.length).equals(SQLITE_PLAINTEXT_HEADER);

    it('control: the detector flags a PLAINTEXT database (so the assertions below can fail)', async () => {
      const plainPath = join(tmpDir, 'plain.db');
      const plain = createClient({ url: pathToFileURL(plainPath).href }); // no encryptionKey
      await plain.execute('CREATE TABLE t (v TEXT)');
      await plain.execute({ sql: 'INSERT INTO t VALUES (?)', args: [MARKER] });
      await plain.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      plain.close();

      const bytes = rawBytes(plainPath);
      expect(startsWithPlaintextHeader(bytes)).toBe(true);
      expect(bytes.includes(MARKER)).toBe(true);
    });

    it('the backup is encrypted: no SQLite plaintext header, and the marker appears nowhere in its bytes', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      await bootstrap(legacy);

      const backup = rawBytes(backupPath(dbPath, AUTH_MIGRATION_TAG));
      expect(backup.length).toBeGreaterThan(SQLITE_PLAINTEXT_HEADER.length);
      expect(startsWithPlaintextHeader(backup)).toBe(false);
      expect(backup.includes(MARKER)).toBe(false);
    });

    it('the main database file holds the same row yet is encrypted too — like compared with like', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      await bootstrap(legacy);
      await legacy.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`); // fold the WAL in so the main file holds the data
      expect((await legacy.all(sql`SELECT 1 FROM transactions WHERE description LIKE ${`%${MARKER}%`}`)).length).toBe(
        1,
      );

      const main = rawBytes(dbPath);
      expect(startsWithPlaintextHeader(main)).toBe(false);
      expect(main.includes(MARKER)).toBe(false);
    });
  });

  it('writes a standalone, encrypted backup: no sidecars, no temp file, unreadable without the key', async () => {
    const legacy = await open();
    await bootstrap(legacy, preAuthFolder);
    await seedDomainData(legacy);
    await bootstrap(legacy);

    const backup = backupPath(dbPath, AUTH_MIGRATION_TAG);
    expect(existsSync(`${backup}.tmp`)).toBe(false);
    expect(existsSync(`${backup}-wal`)).toBe(false);
    const alone = join(tmpDir, 'alone.db');
    cpSync(backup, alone); // the main file only, as an operator restoring it would have
    const restored = await openDatabase({ DB_PATH: alone, FINTRACK_DB_KEY: TEST_KEY });
    expect((await restored.all(sql`SELECT 1 FROM accounts`)).length).toBe(2);
    await expect(
      openDatabase({ DB_PATH: alone, FINTRACK_DB_KEY: 'f'.repeat(64) }).then((db) =>
        db.all(sql`SELECT 1 FROM accounts`),
      ),
    ).rejects.toThrow();
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

  describe('the write barrier between the snapshot and the migration', () => {
    /** A second process: its own connection to the same file, failing fast instead of waiting out a timeout. */
    const intruder = async () => {
      const client = createClient({ url: pathToFileURL(dbPath).href, encryptionKey: TEST_KEY });
      await client.execute('PRAGMA busy_timeout = 0');
      return client;
    };
    const tryWrite = async (client: Awaited<ReturnType<typeof intruder>>): Promise<string> => {
      try {
        await client.execute(
          `INSERT INTO accounts (id, name, type, initial_balance, currency, version) VALUES ('acc-intruder', 'Late', 'wallet', 1, 'USD', 0)`,
        );
        return 'committed';
      } catch (cause) {
        return (cause as { code?: string }).code ?? 'unknown error';
      }
    };

    it('refuses every other writer from the moment the snapshot starts until the migration has committed', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      const other = await intruder();
      const reader = await intruder(); // its own connection: a read here must not pin the writer's WAL snapshot
      const during: string[] = [];

      await applyPendingMigrationsHolding(legacy, REAL_MIGRATIONS_FOLDER, async () => {
        during.push(await tryWrite(other)); // while the snapshot would be taken
        const readable = await reader.execute('SELECT COUNT(*) AS c FROM accounts');
        during.push(`read:${readable.rows[0]?.['c']}`); // reads stay open, so the snapshot can run
      });

      expect(during).toEqual(['SQLITE_BUSY', 'read:2']);
      expect(await tryWrite(other)).toBe('committed'); // and writers are welcome again afterwards
    });

    // migrationBarrier.ts re-implements drizzle's libSQL migrator so it can hold the write lock across the
    // snapshot. This is the guard against the two drifting apart: the same pre-auth database, migrated each way,
    // must be indistinguishable. A drizzle or @libsql/client bump has to keep it green (docs/releasing.md).
    describe("parity with drizzle-orm/libsql's own migrator", () => {
      const openAt = (path: string) => openDatabase({ DB_PATH: path, FINTRACK_DB_KEY: TEST_KEY });

      /** A pre-auth database with the fixture data, at `path`. */
      const preAuthDatabase = async (path: string): Promise<Db> => {
        const db = await openAt(path);
        await bootstrap(db, preAuthFolder);
        await seedDomainData(db);
        return db;
      };

      const schemaOf = (db: Db) =>
        db.all<Row>(sql`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`);
      const bookkeepingOf = (db: Db) =>
        db.all<Row>(sql`SELECT hash, created_at FROM ${sql.identifier(MIGRATIONS_TABLE)} ORDER BY created_at, hash`);
      const usersOf = (db: Db) =>
        // `created_at` is the migration's own clock; everything else is fixed by the SQL.
        db.all<Row>(sql`SELECT id, username, password_hash, role, disabled_at, version FROM users ORDER BY id`);
      const pragmasOf = async (db: Db) => ({
        foreignKeys: await db.all<Row>(sql`PRAGMA foreign_keys`),
        busyTimeout: await db.all<Row>(sql`PRAGMA busy_timeout`),
      });
      // The seeds mint ids and timestamps per database (dashboards), which no migration path can make equal.
      const comparableDump = async (db: Db): Promise<Record<string, Row[]>> => {
        const dump = await domainDump(db);
        const dashboards = (dump['dashboards'] ?? [])
          .map(({ id: _id, updated_at: _updatedAt, ...rest }) => rest)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); // re-sort: the ids were the order
        return { ...dump, dashboards };
      };

      it('yields the same schema, bookkeeping, data and connection settings as drizzle alone', async () => {
        const viaBarrier = await preAuthDatabase(join(tmpDir, 'via-barrier.db'));
        const viaDrizzle = await preAuthDatabase(join(tmpDir, 'via-drizzle.db'));

        // A: this runner. B: drizzle's migrator alone.
        await applyPendingMigrationsHolding(viaBarrier, REAL_MIGRATIONS_FOLDER, async () => undefined);
        await migrate(viaDrizzle, { migrationsFolder: REAL_MIGRATIONS_FOLDER });

        // Compared BEFORE the regular startup pass: bootstrap() runs drizzle's migrate() again, which would quietly
        // finish anything either side under-applied and make a real difference look equal.
        expect(await schemaOf(viaBarrier)).toEqual(await schemaOf(viaDrizzle));
        expect(await bookkeepingOf(viaBarrier)).toEqual(await bookkeepingOf(viaDrizzle));
        expect(await comparableDump(viaBarrier)).toEqual(await comparableDump(viaDrizzle));
        expect(await usersOf(viaBarrier)).toEqual(await usersOf(viaDrizzle));

        // …then the same startup pass on both (migrations no-op, seeds), and the end state must still agree.
        await bootstrap(viaBarrier);
        await bootstrap(viaDrizzle);
        expect(await schemaOf(viaBarrier)).toEqual(await schemaOf(viaDrizzle));
        expect(await bookkeepingOf(viaBarrier)).toEqual(await bookkeepingOf(viaDrizzle));
        expect(await comparableDump(viaBarrier)).toEqual(await comparableDump(viaDrizzle));
        expect(await usersOf(viaBarrier)).toEqual(await usersOf(viaDrizzle));

        // The app's Db after startup behaves the same too — and like one freshly opened on the migrated file.
        const reopened = await openAt(join(tmpDir, 'via-drizzle.db'));
        // Pinned, so "equal" can't mean "equally wrong": foreign keys enforced, the busy timeout on this connection.
        expect(await pragmasOf(viaBarrier)).toEqual({
          foreignKeys: [{ foreign_keys: 1 }],
          busyTimeout: [{ timeout: BUSY_TIMEOUT_MS }],
        });
        expect(await pragmasOf(viaBarrier)).toEqual(await pragmasOf(viaDrizzle));
        expect(await pragmasOf(viaBarrier)).toEqual(await pragmasOf(reopened));
      });

      it('ends the bookkeeping on the last journal entry, and drizzle finds nothing left to apply', async () => {
        const db = await preAuthDatabase(join(tmpDir, 'via-barrier.db'));
        await applyPendingMigrationsHolding(db, REAL_MIGRATIONS_FOLDER, async () => undefined);

        const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
          entries: Array<{ when: number }>;
        };
        const rows = await bookkeepingOf(db);
        expect(Number(rows.at(-1)?.['created_at'])).toBe(journal.entries.at(-1)?.when);
        expect(rows).toHaveLength(journal.entries.length);

        const before = await comparableDump(db);
        await migrate(db, { migrationsFolder: REAL_MIGRATIONS_FOLDER }); // would throw on a re-applied CREATE TABLE
        expect(await comparableDump(db)).toEqual(before);
        expect(await bookkeepingOf(db)).toEqual(rows);
        expect(await ownerRows(db)).toHaveLength(1);
      });
    });

    it('rolls everything back, and frees the lock, when the held step fails', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      const other = await intruder();

      await expect(
        applyPendingMigrationsHolding(legacy, REAL_MIGRATIONS_FOLDER, async () => {
          throw new Error('snapshot failed');
        }),
      ).rejects.toThrow('snapshot failed');

      expect(await legacy.all(sql`SELECT name FROM sqlite_master WHERE name = 'users'`)).toEqual([]);
      expect(await tryWrite(other)).toBe('committed');
    });

    it('rolls everything back, and surfaces the real error, when a migration statement fails part-way', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      const other = await intruder();
      // The real migrations plus one more that fails AFTER 0018's DDL and owner insert have already run.
      const failingFolder = join(tmpDir, 'failing-migrations');
      cpSync(REAL_MIGRATIONS_FOLDER, failingFolder, { recursive: true });
      writeFileSync(join(failingFolder, '0099_bad.sql'), 'INSERT INTO no_such_table (x) VALUES (1);');
      const journalPath = join(failingFolder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<Record<string, unknown>> };
      journal.entries.push({ idx: 99, version: '6', when: Date.now(), tag: '0099_bad', breakpoints: true });
      writeFileSync(journalPath, JSON.stringify(journal));
      const before = await domainDump(legacy);
      const [lastBefore] = await legacy.all<{ created_at: number }>(
        sql`SELECT MAX(created_at) AS created_at FROM ${sql.identifier(MIGRATIONS_TABLE)}`,
      );

      await expect(applyPendingMigrationsHolding(legacy, failingFolder, async () => undefined)).rejects.toThrow(
        /no_such_table/, // the migration's own error, not "transaction closed"
      );

      expect(await legacy.all(sql`SELECT name FROM sqlite_master WHERE name = 'users'`)).toEqual([]);
      expect(await domainDump(legacy)).toEqual(before);
      const [lastAfter] = await legacy.all<{ created_at: number }>(
        sql`SELECT MAX(created_at) AS created_at FROM ${sql.identifier(MIGRATIONS_TABLE)}`,
      );
      expect(lastAfter?.created_at).toBe(lastBefore?.created_at);
      expect(await tryWrite(other)).toBe('committed'); // the write lock was released
    });

    it('fails with a message an operator can act on when another process is holding a write transaction', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      await legacy.run(sql`PRAGMA busy_timeout = 50`); // the first connection's wait, shortened for the test
      const holder = await intruder();
      const writing = await holder.transaction('write');

      await expect(
        applyPendingMigrationsHolding(legacy, REAL_MIGRATIONS_FOLDER, async () => undefined),
      ).rejects.toThrow(/another FinTrack process is writing/);

      await writing.rollback();
      expect(await legacy.all(sql`SELECT name FROM sqlite_master WHERE name = 'users'`)).toEqual([]);
    });

    it('takes the real backup through the barrier: a late writer is refused while it is taken', async () => {
      const legacy = await open();
      await bootstrap(legacy, preAuthFolder);
      await seedDomainData(legacy);
      const other = await intruder();
      const refused: string[] = [];
      // Every console.error line the backup logs is a moment inside the held section.
      stderr.mockImplementation(((message: unknown) => {
        if (String(message).includes('backed up')) void tryWrite(other).then((outcome) => refused.push(outcome));
      }) as never);

      await bootstrap(legacy);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(refused).toEqual(['SQLITE_BUSY']);
      expect(existsSync(backupPath(dbPath, AUTH_MIGRATION_TAG))).toBe(true);
    });
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
