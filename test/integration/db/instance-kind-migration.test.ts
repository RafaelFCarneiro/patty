import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { DATA_REWRITING_MIGRATIONS } from '../../../src/diplomat/db/migrations.js';
import { instanceRepo } from '../../../src/diplomat/db/repos/instance.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

const TEST_KEY = 'e'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const MIGRATION_TAG = '0025_instance_kind';

let tmpDir: string;
let dbPath: string;
let beforeFolder: string;

/** A copy of the real migrations whose journal stops just before this one: a database as the last release left it. */
const journalBefore = (folder: string): void => {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const cutoff = journal.entries.findIndex((entry) => entry.tag === MIGRATION_TAG);
  if (cutoff === -1) throw new Error(`${MIGRATION_TAG} not in ${journalPath}`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
};

const open = () => openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, PATTY_DB_KEY: TEST_KEY });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-instance-kind-migration-'));
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

describe('migration 0025 — instance kind', () => {
  it('only adds a column, so no safety copy is taken', () => {
    expect(DATA_REWRITING_MIGRATIONS).not.toContain(MIGRATION_TAG);
  });

  it('marks an existing database standard, keeping its settings row', async () => {
    const db = await open();
    await migrate(db, { migrationsFolder: beforeFolder });
    await db.run(sql`UPDATE settings SET max_sign_in_duration = '7d', version = 4 WHERE id = 'singleton'`);
    await bootstrap(db);

    expect(await db.all(sql`SELECT id, max_sign_in_duration, instance_kind, version FROM settings`)).toEqual([
      { id: 'singleton', max_sign_in_duration: '7d', instance_kind: 'standard', version: 4 },
    ]);
    expect(await instanceRepo(db).kind()).toBe(InstanceKind.enum.standard);
  });

  it('a new database is standard until something marks it a demo', async () => {
    const db = await open();
    await bootstrap(db);
    const repo = instanceRepo(db);
    expect(await repo.kind()).toBe(InstanceKind.enum.standard);

    await db.run(sql`UPDATE settings SET instance_kind = 'demo' WHERE id = 'singleton'`);
    expect(await repo.kind()).toBe(InstanceKind.enum.demo);
  });

  it('refuses a value that is not a kind', async () => {
    const db = await open();
    await bootstrap(db);
    await db.run(sql`UPDATE settings SET instance_kind = 'staging' WHERE id = 'singleton'`);
    await expect(instanceRepo(db).kind()).rejects.toThrow();
  });
});
