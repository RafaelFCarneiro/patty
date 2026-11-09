import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { type Db, openDatabase } from '../../../src/diplomat/db/driver.js';
import { dashboards } from '../../../src/diplomat/db/schema.js';
import {
  dashboardsRepo,
  listDefaultDashboardFiles,
  UI_DASHBOARDS_ROOT,
} from '../../../src/diplomat/db/repos/dashboards.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

const TEST_KEY = 'a'.repeat(64);

let tmpDir: string;
let db: Db;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-dashboard-file-backed-'));
  db = await openDatabase({
    KEY_LOCK_PATH: keyLockPathForTest(),
    DB_PATH: join(tmpDir, 'file-backed.db'),
    FINTRACK_DB_KEY: TEST_KEY,
  });
  await bootstrap(db);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('bootstrap seeds default dashboards from ui/dashboards/*.html (ADR-027 Phase 2)', () => {
  it('registers "overview" as a source: file row on a fresh install', async () => {
    const list = await dashboardsRepo(db, OWNER_USER_ID).list();
    expect(list).toContainEqual(expect.objectContaining({ name: 'overview', source: 'file' }));
  });

  it('resolves the dashboard content by reading ui/dashboards/overview.html, matching the file verbatim', async () => {
    const onDisk = await readFile(join(UI_DASHBOARDS_ROOT, 'overview.html'), 'utf-8');
    const dashboard = await dashboardsRepo(db, OWNER_USER_ID).get('overview');
    expect(dashboard?.html).toBe(onDisk);
    expect(dashboard?.source).toBe('file');
  });

  it('findByName carries the path alongside source: file, for rename to preserve', async () => {
    const entity = await dashboardsRepo(db, OWNER_USER_ID).findByName('overview');
    expect(entity?.source).toBe('file');
    expect(entity?.path).toBe('overview.html');
  });

  it('lists at least one *.html file under ui/dashboards/ — the same set bootstrap reconciles against', async () => {
    const files = await listDefaultDashboardFiles();
    expect(files).toContain('overview.html');
  });

  it('re-running bootstrap does not duplicate or touch the already-seeded row (onConflictDoNothing)', async () => {
    const before = await dashboardsRepo(db, OWNER_USER_ID).findByName('overview');
    await bootstrap(db);
    const after = await dashboardsRepo(db, OWNER_USER_ID).findByName('overview');
    expect(after).toEqual(before);
    const list = await dashboardsRepo(db, OWNER_USER_ID).list();
    expect(list.filter((d) => d.name === 'overview')).toHaveLength(1);
  });
});

describe('dashboardsRepo resolves source: file content safely (ADR-027 Phase 2)', () => {
  it('rejects a path escaping ui/dashboards/ — defense-in-depth even though only bootstrap sets path', async () => {
    const name = `escaping-${randomUUID()}`;
    await db.insert(dashboards).values({
      id: randomUUID(),
      name,
      html: null,
      source: 'file',
      path: '../../etc/passwd',
      updatedAt: '2026-01-01',
    });

    await expect(dashboardsRepo(db, OWNER_USER_ID).get(name)).rejects.toThrow(/escapes ui\/dashboards/);
  });

  it('propagates a read failure for a source: file row whose file is missing', async () => {
    const name = `missing-file-${randomUUID()}`;
    await db.insert(dashboards).values({
      id: randomUUID(),
      name,
      html: null,
      source: 'file',
      path: 'does-not-exist.html',
      updatedAt: '2026-01-01',
    });

    await expect(dashboardsRepo(db, OWNER_USER_ID).get(name)).rejects.toThrow();
  });
});
