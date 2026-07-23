import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { dashboardsRepo } from '../../../src/diplomat/db/repos/dashboards.js';

const TEST_KEY = 'f'.repeat(64);
const REAL_MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const MIGRATION_0011_TAG = '0011_dashboard_id_normalization';

let tmpDir: string;
let dbPath: string;
let preMigrationFolder: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-dashboard-migration-'));
  dbPath = join(tmpDir, 'migration.db');

  // A copy of the real migrations folder with 0011's journal entry removed, so migrating against
  // it stops one version short — simulating a DB that predates id-normalization.
  preMigrationFolder = join(tmpDir, 'pre-0011-migrations');
  cpSync(REAL_MIGRATIONS_FOLDER, preMigrationFolder, { recursive: true });
  const journalPath = join(preMigrationFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.filter((entry) => entry.tag !== MIGRATION_0011_TAG);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
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

describe('migration 0011 — dashboards id normalization', () => {
  it('backfills a stable UUID id for a pre-existing name-keyed row, preserving content and name UNIQUE', async () => {
    const db = openDatabase(openOpts());
    await migrate(db, { migrationsFolder: preMigrationFolder });

    await db.run(
      sql`INSERT INTO dashboards (name, html, updated_at, version) VALUES ('legacy', '<html>old</html>', '2026-01-01', 0)`,
    );

    await migrate(db, { migrationsFolder: REAL_MIGRATIONS_FOLDER });

    const rows = await db.all<{ id: string; name: string; html: string; updated_at: string; version: number }>(
      sql`SELECT id, name, html, updated_at, version FROM dashboards WHERE name = 'legacy'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows[0]?.html).toBe('<html>old</html>');
    expect(rows[0]?.updated_at).toBe('2026-01-01');
    expect(rows[0]?.version).toBe(0);

    await expect(
      db.run(
        sql`INSERT INTO dashboards (id, name, html, updated_at, version) VALUES (${randomUUID()}, 'legacy', '<html>dup</html>', '2026-01-02', 0)`,
      ),
    ).rejects.toThrow();

    const repo = dashboardsRepo(db);
    expect(await repo.get('legacy')).toEqual({ name: 'legacy', html: '<html>old</html>', updatedAt: '2026-01-01' });
    expect(await repo.list()).toEqual([{ name: 'legacy', updatedAt: '2026-01-01' }]);
  });
});
