import { describe, expect, it, vi } from 'vitest';
import { getDashboard, listDashboards, saveDashboard } from '../../../src/controllers/dashboards.js';
import type { Deps } from '../../../src/controllers/deps.js';
import { DASHBOARD_ENTITY_TAG } from '../../../src/models/dashboard.js';
import type { Dashboard, DashboardEntity, DashboardListItem } from '../../../src/models/dashboard.js';
import { PersistOp } from '../../../src/models/persistable.js';

const FIXED_CLOCK = new Date('2026-07-02T12:00:00.000Z');

const makeDeps = (overrides?: Partial<Deps['dashboards']>): Deps => ({
  dashboards: {
    findRawByName: vi.fn(async () => null),
    get: vi.fn(async () => null),
    list: vi.fn(async (): Promise<DashboardListItem[]> => []),
    ...overrides,
  },
  accounts: {} as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => FIXED_CLOCK,
  newId: () => 'test-id',
  locale: async () => 'en',
});

describe('saveDashboard', () => {
  it('emits an insert and returns the saved dashboard when absent', async () => {
    const deps = makeDeps();
    const result = await saveDashboard(deps, 'overview', '<html></html>');
    const outcome = result._unsafeUnwrap();
    const dashboard: Dashboard = { name: 'overview', html: '<html></html>', updatedAt: FIXED_CLOCK.toISOString() };
    expect(outcome.response).toEqual(dashboard);
    expect(outcome.persist).toEqual([{ op: PersistOp.enum.insert, entity: DASHBOARD_ENTITY_TAG, model: dashboard }]);
  });

  it('emits a version-guarded update and overwrites by name when present', async () => {
    const existing: DashboardEntity = {
      name: 'overview',
      html: '<html>old</html>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 4,
    };
    const deps = makeDeps({ findRawByName: vi.fn(async () => existing) });
    const result = await saveDashboard(deps, 'overview', '<html>new</html>');
    const outcome = result._unsafeUnwrap();
    const dashboard: Dashboard = { name: 'overview', html: '<html>new</html>', updatedAt: FIXED_CLOCK.toISOString() };
    expect(outcome.response).toEqual(dashboard);
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.update, entity: DASHBOARD_ENTITY_TAG, model: { ...dashboard, version: 4 } },
    ]);
  });

  it('rejects html with no <html> root without reading the repo for a decision', async () => {
    const deps = makeDeps();
    const result = await saveDashboard(deps, 'overview', 'not html at all');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    // The exact wording is covered by findHtmlValidationIssues's own unit tests
    // (test/unit/logic/dashboard.test.ts) — asserting a substring here keeps this test focused on
    // saveDashboard's own behavior (reject + never touch the repo) without duplicating that string.
    expect((error as { issues: string[] }).issues.some((issue) => issue.includes('root element'))).toBe(true);
    expect(deps.dashboards.findRawByName).not.toHaveBeenCalled();
  });

  it('rejects html with a broken inline <script> without reading the repo for a decision', async () => {
    const deps = makeDeps();
    const html = '<!doctype html><html><body><script>function( { broken</script></body></html>';
    const result = await saveDashboard(deps, 'overview', html);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect((error as { issues: string[] }).issues.some((issue) => issue.includes('syntax error'))).toBe(true);
    expect(deps.dashboards.findRawByName).not.toHaveBeenCalled();
  });
});

describe('listDashboards', () => {
  it('delegates to the repo', async () => {
    const items: DashboardListItem[] = [{ name: 'overview', updatedAt: FIXED_CLOCK.toISOString() }];
    const deps = makeDeps({ list: vi.fn(async () => items) });
    expect(await listDashboards(deps)).toEqual(items);
  });
});

describe('getDashboard', () => {
  it('returns the dashboard when found', async () => {
    const dashboard: Dashboard = { name: 'overview', html: '<html></html>', updatedAt: FIXED_CLOCK.toISOString() };
    const deps = makeDeps({ get: vi.fn(async () => dashboard) });
    const result = await getDashboard(deps, 'overview');
    expect(result._unsafeUnwrap()).toEqual(dashboard);
  });

  it('returns unknown_dashboard when absent', async () => {
    const deps = makeDeps({ get: vi.fn(async () => null) });
    const result = await getDashboard(deps, 'missing');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'unknown_dashboard', query: 'missing', candidates: [] });
  });
});
