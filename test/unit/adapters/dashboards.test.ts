import { describe, expect, it } from 'vitest';
import * as dashboardAdapters from '../../../src/adapters/dashboards.js';

describe('dbToModel', () => {
  it('maps a db row to a Dashboard model', () => {
    const dashboard = dashboardAdapters.dbToModel({
      name: 'overview',
      html: '<html></html>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
    });
    expect(dashboard).toEqual({ name: 'overview', html: '<html></html>', updatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('throws when name is an empty string', () => {
    expect(() =>
      dashboardAdapters.dbToModel({
        name: '',
        html: '<html></html>',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 0,
      }),
    ).toThrow();
  });
});

describe('dbToListItem', () => {
  it('maps a db row to a DashboardListItem, omitting html', () => {
    const item = dashboardAdapters.dbToListItem({ name: 'overview', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(item).toEqual({ name: 'overview', updatedAt: '2026-01-01T00:00:00.000Z' });
  });
});
