import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase, type Db } from '../../../src/diplomat/db/driver.js';
import { MIGRATIONS_TABLE } from '../../../src/diplomat/db/migrationBarrier.js';
import { DatabaseAheadError } from '../../../src/common/databaseAhead.js';
import { assertDatabaseNotAhead } from '../../../src/diplomat/db/versionGuard.js';
import { databaseAheadMessage } from '../../../src/models/database.js';

const TEST_KEY = 'f'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as {
    version: string;
  }
).version;

let tmpDir: string;
let dbPath: string;
const opened: Db[] = [];

const open = async (): Promise<Db> => {
  const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: TEST_KEY });
  opened.push(db);
  return db;
};

type Journal = { entries: Array<{ tag: string; when: number }> };

/** A copy of the real migrations folder whose journal stops `drop` migrations early — an older build’s view. */
const olderBuild = (drop: number): string => {
  const folder = join(tmpDir, `older-by-${drop}`);
  cpSync(REAL_MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Journal;
  journal.entries = journal.entries.slice(0, journal.entries.length - drop);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return folder;
};

const rowCounts = async (db: Db): Promise<Record<string, number>> => {
  const tables = await db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'transactions_fts%' ORDER BY name`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(name)}`);
    counts[name] = row?.n ?? 0;
  }
  return counts;
};

const fileFingerprint = () => {
  const stats = statSync(dbPath);
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
  };
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-version-guard-'));
  dbPath = join(tmpDir, 'fintrack.db');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  opened.splice(0).forEach(closeDatabase);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('the version guard (ADR-034 §7)', () => {
  it('refuses a database migrated by a newer build — with the one message — and writes nothing at all', async () => {
    const db = await open();
    await bootstrap(db);
    // A seeded row an older build’s seeding would put back: if the guard really runs first, it stays missing.
    await db.run(sql`DELETE FROM currencies WHERE code = 'BTC'`);
    await db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
    const before = { counts: await rowCounts(db), file: fileFingerprint(), dir: readdirSync(tmpDir).sort() };
    const stale = olderBuild(1);

    const refusal = await bootstrap(db, stale).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DatabaseAheadError);
    expect((refusal as Error).message).toBe(databaseAheadMessage(PACKAGE_VERSION));
    await db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
    expect(await rowCounts(db)).toEqual(before.counts);
    expect(await db.all(sql`SELECT 1 FROM currencies WHERE code = 'BTC'`)).toEqual([]); // not re-seeded
    expect(fileFingerprint()).toEqual(before.file); // size, mtime and every byte
    expect(readdirSync(tmpDir).sort()).toEqual([...before.dir, 'older-by-1'].sort()); // no .bak, no lock file
  });

  it('refuses an older build several migrations behind just the same', async () => {
    const db = await open();
    await bootstrap(db);
    await expect(bootstrap(db, olderBuild(5))).rejects.toBeInstanceOf(DatabaseAheadError);
  });

  it('runs before the safety copy: no backup is made even though this build would have wanted one', async () => {
    const db = await open();
    await bootstrap(db);
    await bootstrap(db, olderBuild(1)).catch(() => undefined);
    expect(readdirSync(tmpDir).filter((name) => name.includes('.bak'))).toEqual([]);
  });

  it('lets a database exactly at this build’s newest migration proceed', async () => {
    const db = await open();
    await bootstrap(db);
    await expect(bootstrap(db)).resolves.toBeUndefined();
    await expect(assertDatabaseNotAhead(db, REAL_MIGRATIONS_FOLDER)).resolves.toBeUndefined();
  });

  it('lets a database behind this build proceed — and migrates it', async () => {
    const db = await open();
    await bootstrap(db, olderBuild(2));
    const behind = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(MIGRATIONS_TABLE)}`);

    await bootstrap(db);

    const after = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.identifier(MIGRATIONS_TABLE)}`);
    expect((after[0]?.n ?? 0) - (behind[0]?.n ?? 0)).toBe(2);
  });

  it('lets a brand-new database (no migrations table yet) proceed', async () => {
    const db = await open();
    await expect(assertDatabaseNotAhead(db, REAL_MIGRATIONS_FOLDER)).resolves.toBeUndefined();
    await expect(bootstrap(db)).resolves.toBeUndefined();
  });

  it('sees a database whose newest migration has a stamp this build has never heard of', async () => {
    const db = await open();
    await bootstrap(db);
    await db.run(
      sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} (hash, created_at) VALUES ('from-the-future', ${Date.now() + 10 * 365 * 24 * 3600 * 1000})`,
    );
    await expect(bootstrap(db)).rejects.toThrow(databaseAheadMessage(PACKAGE_VERSION));
  });

  it('names no path and no key in what it says', async () => {
    const db = await open();
    await bootstrap(db);
    const refusal = (await bootstrap(db, olderBuild(1)).catch((error: unknown) => error)) as Error;
    expect(refusal.message).not.toContain(tmpDir);
    expect(refusal.message).not.toContain(TEST_KEY);
  });
});
