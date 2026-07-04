import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { openDatabase } from '../../../src/diplomat/db/driver.js';
import { dashboardsRepo } from '../../../src/diplomat/db/repos/dashboards.js';

const TEST_KEY = 'e'.repeat(64);

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-dashboard-seed-'));
  dbPath = join(tmpDir, 'seed.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const openOpts = () => ({
  DB_PATH: dbPath,
  FINTRACK_DB_KEY: TEST_KEY,
  PORT: 3001,
  MCP_TRANSPORT: McpTransport.enum.http,
});

describe('dashboard seed persistence across restart (ADR-008 onConflictDoNothing)', () => {
  it('re-running bootstrap on an existing DB does not revert a save_dashboard override', async () => {
    const firstDb = openDatabase(openOpts());
    await bootstrap(firstDb);

    const overriddenHtml = '<html><body>my custom dashboard</body></html>';
    await dashboardsRepo(firstDb).upsert('overview', overriddenHtml, new Date().toISOString());

    // Simulate a restart: reopen the same file and bootstrap again.
    const secondDb = openDatabase(openOpts());
    await bootstrap(secondDb);

    const after = await dashboardsRepo(secondDb).get('overview');
    expect(after?.html).toBe(overriddenHtml);
  });
});
