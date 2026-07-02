import { describe, expect, it } from 'vitest';
import {
  dashboardErrors,
  DashboardListItemSchema,
  DashboardSchema,
  SaveDashboardSchema,
} from '../../../src/models/dashboard.js';

describe('DashboardSchema', () => {
  it('accepts a valid dashboard', () => {
    const result = DashboardSchema.safeParse({
      name: 'overview',
      html: '<html></html>',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(
      DashboardSchema.safeParse({ name: '', html: '<html></html>', updatedAt: '2026-01-01T00:00:00.000Z' }).success,
    ).toBe(false);
  });
});

describe('DashboardListItemSchema', () => {
  it('omits html', () => {
    const parsed = DashboardListItemSchema.parse({ name: 'overview', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(parsed).toEqual({ name: 'overview', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect('html' in parsed).toBe(false);
  });
});

describe('SaveDashboardSchema', () => {
  it('accepts name + html only', () => {
    expect(SaveDashboardSchema.safeParse({ name: 'overview', html: '<html></html>' }).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(SaveDashboardSchema.safeParse({ name: '', html: '<html></html>' }).success).toBe(false);
  });
});

describe('dashboardErrors.notFound', () => {
  it('builds an unknown_dashboard error with an empty candidates list', () => {
    expect(dashboardErrors.notFound('missing')).toEqual({
      code: 'unknown_dashboard',
      query: 'missing',
      candidates: [],
    });
  });
});

describe('dashboardErrors.invalidHtml', () => {
  it('builds a validation error carrying the given issues', () => {
    expect(dashboardErrors.invalidHtml(['html must contain a <!doctype html> or <html> root element'])).toEqual({
      code: 'validation',
      issues: ['html must contain a <!doctype html> or <html> root element'],
    });
  });
});
