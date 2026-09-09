import { describe, expect, it } from 'vitest';
import * as budgetAdapters from '../../../src/adapters/budgets.js';
import { createBudget } from '../../../src/controllers/budgets.js';
import type { CreateBudget } from '../../../src/models/budget.js';
import { setupHttpTest } from './setup.js';

const { inject, getDeps, getRunEffects } = setupHttpTest();

// Budget writes stay MCP-only (no REST create route), so fixtures for these REST-read tests are
// seeded straight through the controller rather than via `inject`, mirroring how every other
// domain seeds its fixtures through its own REST create route.
const seedBudget = async (input: CreateBudget) => {
  const deps = getDeps();
  const runEffects = getRunEffects();
  const flow = () => createBudget(deps, input).map(budgetAdapters.outcomeToDb);
  const result = await runEffects(flow);
  if (result.isErr()) throw new Error(`seedBudget failed: ${JSON.stringify(result.error)}`);
  return result.value;
};

describe('GET /api/budgets', () => {
  it('lists budgets', async () => {
    await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Budget REST Cat' } });
    await seedBudget({ category: 'Budget REST Cat', currency: 'USD', limit: 500, period: 'monthly' });

    const res = await inject({ method: 'GET', url: '/api/budgets' });
    expect(res.statusCode).toBe(200);
    const budgets = res.json() as Array<{ category: string; limit: number }>;
    expect(budgets.some((b) => b.category === 'Budget REST Cat' && b.limit === 500)).toBe(true);
  });
});

describe('GET /api/budgets/status', () => {
  it('returns spend-vs-limit for the period', async () => {
    await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Budget Status REST Cat' } });
    await seedBudget({ category: 'Budget Status REST Cat', currency: 'USD', limit: 200, period: 'monthly' });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Budget Status REST Acct', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Budget status REST expense',
        amount: 50,
        date: '2026-05-01',
        account: 'Budget Status REST Acct',
        category: 'Budget Status REST Cat',
      },
    });

    const res = await inject({ method: 'GET', url: '/api/budgets/status?month=5&year=2026' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      categories: Array<{ category: string; lines: Array<{ effective: { amount: number } }> }>;
    };
    const group = body.categories.find((c) => c.category === 'Budget Status REST Cat');
    expect(group).toBeDefined();
    expect(group!.lines[0]!.effective.amount).toBe(50);
  });

  it('coerces string month/year', async () => {
    const res = await inject({ method: 'GET', url: '/api/budgets/status?month=6&year=2026' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects month out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/budgets/status?month=0&year=2026' });
    expect(res.statusCode).toBe(422);
  });

  it('rejects year out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/budgets/status?month=1&year=1999' });
    expect(res.statusCode).toBe(422);
  });

  describe('displayCurrency', () => {
    // Pins deps.clock so staleness/asOf is deterministic.
    const RATE_ASOF = '2026-08-10T10:00:00.000Z';
    const FIXED_NOW = new Date('2026-08-10T12:00:00.000Z');

    type BudgetStatusBody = {
      period: { month: number; year: number };
      categories: Array<{ category: string; lines: Array<{ committed: { amount: number } }> }>;
      converted?: {
        displayCurrency: string;
        total: number;
        stale: boolean;
        asOf: string | null;
        excluded: Array<{ currency: string; reason: string }>;
      };
    };

    it('omitted displayCurrency: response has no converted block (regression pin)', async () => {
      await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dc Omit Cat' } });
      await seedBudget({ category: 'Dc Omit Cat', currency: 'USD', limit: 200, period: 'monthly' });
      const res = await inject({ method: 'GET', url: '/api/budgets/status?month=3&year=2026' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('converted');
    });

    it('provided displayCurrency: converts + sums committed spend, per-category lines unchanged', async () => {
      const deps = getDeps();
      const originalClock = deps.clock;
      deps.clock = () => FIXED_NOW;

      try {
        await inject({
          method: 'POST',
          url: '/api/exchange-rates',
          payload: { from: 'BRL', to: 'USD', rate: 0.2, asOf: RATE_ASOF },
        });
        await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dc Usd Cat' } });
        await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dc Brl Cat' } });
        await seedBudget({ category: 'Dc Usd Cat', currency: 'USD', limit: 500, period: 'monthly' });
        await seedBudget({ category: 'Dc Brl Cat', currency: 'BRL', limit: 1000, period: 'monthly' });
        await inject({
          method: 'POST',
          url: '/api/accounts',
          payload: { name: 'Dc Usd Acct', type: 'checking', currency: 'USD', initialBalance: 0 },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts',
          payload: { name: 'Dc Brl Acct', type: 'checking', currency: 'BRL', initialBalance: 0 },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts/expenses',
          payload: {
            description: 'Dc usd budget exp',
            amount: 100,
            date: '2026-08-02',
            account: 'Dc Usd Acct',
            category: 'Dc Usd Cat',
          },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts/expenses',
          payload: {
            description: 'Dc brl budget exp',
            amount: 500,
            date: '2026-08-02',
            account: 'Dc Brl Acct',
            category: 'Dc Brl Cat',
          },
        });

        const withoutConversion = await inject({ method: 'GET', url: '/api/budgets/status?month=8&year=2026' });
        const withConversion = await inject({
          method: 'GET',
          url: '/api/budgets/status?month=8&year=2026&displayCurrency=USD',
        });
        expect(withConversion.statusCode).toBe(200);
        const withoutBody = withoutConversion.json() as BudgetStatusBody;
        const withBody = withConversion.json() as BudgetStatusBody;

        expect(withBody.categories).toEqual(withoutBody.categories);
        // The query string also carries displayCurrency — period must not leak it (regression).
        expect(withBody.period).toEqual({ month: 8, year: 2026 });
        const usdLine = withBody.categories.find((c) => c.category === 'Dc Usd Cat');
        const brlLine = withBody.categories.find((c) => c.category === 'Dc Brl Cat');
        expect(usdLine?.lines[0]?.committed.amount).toBe(100);
        expect(brlLine?.lines[0]?.committed.amount).toBe(500);
        // USD identity 100 + BRL 500 * 0.2 = 100 -> 200; other tests in this shared-DB suite may
        // also add budgeted spend for this same month, so assert at least the expected floor.
        expect(withBody.converted?.displayCurrency).toBe('USD');
        expect(withBody.converted?.total).toBeGreaterThanOrEqual(200);
        expect(withBody.converted?.stale).toBe(false);
      } finally {
        deps.clock = originalClock;
      }
    });

    it('a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
      await inject({ method: 'POST', url: '/api/categories', payload: { name: 'Dc Btc Cat' } });
      await seedBudget({ category: 'Dc Btc Cat', currency: 'BTC', limit: 1, period: 'monthly' });
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'Dc Btc Budget Acct', type: 'checking', currency: 'BTC', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Dc btc budget exp',
          amount: 0.1,
          date: '2026-01-03',
          account: 'Dc Btc Budget Acct',
          category: 'Dc Btc Cat',
        },
      });
      const res = await inject({ method: 'GET', url: '/api/budgets/status?month=1&year=2026&displayCurrency=USD' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BudgetStatusBody;
      expect(body.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    });

    it('rejects an unknown displayCurrency (422)', async () => {
      const res = await inject({ method: 'GET', url: '/api/budgets/status?month=7&year=2026&displayCurrency=EUR' });
      expect(res.statusCode).toBe(422);
    });
  });
});
