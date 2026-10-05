import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTransport } from '../../../src/config.js';
import { saveDashboard } from '../../../src/controllers/dashboards.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { createTransactionRunner, openDatabase } from '../../../src/diplomat/db/driver.js';
import type { ApplierRegistry } from '../../../src/diplomat/db/effects.js';
import { dashboardApplier, dashboardsRepo } from '../../../src/diplomat/db/repos/dashboards.js';
import { isSqliteBusy } from '../../../src/diplomat/db/sqliteErrors.js';
import { runEffects } from '@rfc0/effect-runner';
import { DASHBOARD_ENTITY_TAG } from '../../../src/models/dashboard.js';
import { conflict } from '../../../src/models/error.js';
import { Locale } from '../../../src/models/locale.js';

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
  FINTRACK_HTTP: true,
});

describe('dashboard seed persistence across restart (ADR-008 onConflictDoNothing)', () => {
  it('re-running bootstrap on an existing DB does not revert a save_dashboard override', async () => {
    const firstDb = await openDatabase(openOpts());
    await bootstrap(firstDb);

    const overriddenHtml = '<section>my custom dashboard</section>';
    const deps = {
      dashboards: dashboardsRepo(firstDb),
      clock: () => new Date(),
      locale: async () => Locale.enum.en,
    } as unknown as Deps;
    const registry: ApplierRegistry = { [DASHBOARD_ENTITY_TAG]: dashboardApplier };
    const result = await runEffects(
      { runner: createTransactionRunner(firstDb), isTransientContention: isSqliteBusy, conflictError: () => conflict },
      registry,
      () => saveDashboard(deps, 'overview', overriddenHtml),
    );
    expect(result.isOk()).toBe(true);

    // Simulate a restart: reopen the same file and bootstrap again.
    const secondDb = await openDatabase(openOpts());
    await bootstrap(secondDb);

    const after = await dashboardsRepo(secondDb).get('overview');
    expect(after?.html).toBe(overriddenHtml);
  });
});
