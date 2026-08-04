import { describe, expect, it } from 'vitest';
import * as dashboardAdapters from '../../../src/adapters/dashboards.js';
import { DashboardSource } from '../../../src/models/dashboard.js';

describe('dbToModel', () => {
  it('maps an inline row to a Dashboard model, stripping id', () => {
    const dashboard = dashboardAdapters.dbToModel(
      {
        id: 'dash-1',
        name: 'overview',
        html: '<html></html>',
        source: DashboardSource.enum.inline,
        path: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 0,
      },
      '<html></html>',
    );
    expect(dashboard).toEqual({
      name: 'overview',
      html: '<html></html>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      source: 'inline',
    });
    expect('id' in dashboard).toBe(false);
  });

  it('uses the resolved html argument, not row.html — a source: file row carries a null column', () => {
    const dashboard = dashboardAdapters.dbToModel(
      {
        id: 'dash-1',
        name: 'overview',
        html: null,
        source: DashboardSource.enum.file,
        path: 'overview.html',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 0,
      },
      '<section>from disk</section>',
    );
    expect(dashboard).toEqual({
      name: 'overview',
      html: '<section>from disk</section>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      source: 'file',
    });
  });

  it('throws when name is an empty string', () => {
    expect(() =>
      dashboardAdapters.dbToModel(
        {
          id: 'dash-1',
          name: '',
          html: '<html></html>',
          source: DashboardSource.enum.inline,
          path: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          version: 0,
        },
        '<html></html>',
      ),
    ).toThrow();
  });
});

describe('dbToEntity', () => {
  it('maps an inline row to a DashboardEntity, keeping id, version, and a null path', () => {
    const entity = dashboardAdapters.dbToEntity(
      {
        id: 'dash-1',
        name: 'overview',
        html: '<html></html>',
        source: DashboardSource.enum.inline,
        path: null,
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 2,
      },
      '<html></html>',
    );
    expect(entity).toEqual({
      id: 'dash-1',
      name: 'overview',
      html: '<html></html>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 2,
      source: 'inline',
      path: null,
    });
  });

  it('maps a file-backed row, keeping its path', () => {
    const entity = dashboardAdapters.dbToEntity(
      {
        id: 'dash-1',
        name: 'overview',
        html: null,
        source: DashboardSource.enum.file,
        path: 'overview.html',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 0,
      },
      '<section>from disk</section>',
    );
    expect(entity).toEqual({
      id: 'dash-1',
      name: 'overview',
      html: '<section>from disk</section>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
      source: 'file',
      path: 'overview.html',
    });
  });
});

describe('dbToListItem', () => {
  it('maps a db row to a DashboardListItem, omitting html', () => {
    const item = dashboardAdapters.dbToListItem({
      name: 'overview',
      updatedAt: '2026-01-01T00:00:00.000Z',
      source: DashboardSource.enum.inline,
    });
    expect(item).toEqual({ name: 'overview', updatedAt: '2026-01-01T00:00:00.000Z', source: 'inline' });
  });
});

describe('modelToDb', () => {
  it('nulls out path and keeps html for an inline entity', () => {
    const row = dashboardAdapters.modelToDb({
      id: 'dash-1',
      name: 'overview',
      html: '<section></section>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
      source: DashboardSource.enum.inline,
      path: 'stray-path-must-be-discarded.html',
    });
    expect(row).toEqual({
      id: 'dash-1',
      name: 'overview',
      html: '<section></section>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
      source: 'inline',
      path: null,
    });
  });

  it('nulls out html and keeps path for a file-backed entity', () => {
    const row = dashboardAdapters.modelToDb({
      id: 'dash-1',
      name: 'overview',
      html: '<section>ignored — resolved from disk, never persisted</section>',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
      source: DashboardSource.enum.file,
      path: 'overview.html',
    });
    expect(row).toEqual({
      id: 'dash-1',
      name: 'overview',
      html: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 0,
      source: 'file',
      path: 'overview.html',
    });
  });
});
