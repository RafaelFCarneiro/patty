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
        idempotencyKey: 'budget-status-rest-exp',
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
});
