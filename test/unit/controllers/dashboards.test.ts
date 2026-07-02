import { describe, expect, it, vi } from 'vitest';
import { getDashboard, listDashboards, saveDashboard } from '../../../src/controllers/dashboards.js';
import type { Deps } from '../../../src/controllers/deps.js';
import type { Dashboard, DashboardListItem } from '../../../src/models/dashboard.js';

const FIXED_CLOCK = new Date('2026-07-02T12:00:00.000Z');

const makeDeps = (overrides?: Partial<Deps['dashboards']>): Deps => ({
  dashboards: {
    upsert: vi.fn(async (name: string, html: string, updatedAt: string): Promise<Dashboard> => ({
      name,
      html,
      updatedAt,
    })),
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
  resetLocale: vi.fn(),
});

describe('saveDashboard', () => {
  it('upserts using the current clock as updatedAt', async () => {
    const deps = makeDeps();
    const dashboard = await saveDashboard(deps, 'overview', '<html></html>');
    expect(dashboard).toEqual({ name: 'overview', html: '<html></html>', updatedAt: FIXED_CLOCK.toISOString() });
    expect(deps.dashboards.upsert).toHaveBeenCalledWith('overview', '<html></html>', FIXED_CLOCK.toISOString());
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
