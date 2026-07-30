import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/recurring', () => {
  it('lists recurring rules', async () => {
    const res = await inject({ method: 'GET', url: '/api/recurring' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('resolves the linked account name', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Recurring Test Account', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Named Account Rule',
        amount: 42,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        account: 'Recurring Test Account',
      },
    });

    const res = await inject({ method: 'GET', url: '/api/recurring' });
    const rules = res.json() as Array<{ description?: string; accountName?: string }>;
    const rule = rules.find((r) => r.description === 'Named Account Rule');
    expect(rule?.accountName).toBe('Recurring Test Account');
  });
});

describe('recurring merchant', () => {
  it('derives merchantKey from description when merchant is omitted', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Netflix',
        amount: 39.9,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().merchantKey).toBe('netflix');
  });

  it('uses the explicit merchant over the description when both are given', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Monthly rent payment',
        amount: 2000,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        currency: 'USD',
        merchant: 'Landlord LLC',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().merchantKey).toBe('landlord llc');
  });
});

describe('POST /api/recurring', () => {
  it('creates a recurring rule (201)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Rent',
        amount: 1200,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        currency: 'USD',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('id');
  });

  it('defaults currency to USD when no account linked', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: { description: 'No acct', amount: 50, type: 'expense', period: 'weekly', startDate: '2026-07-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().currency).toBe('USD');
  });

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/recurring', payload: {} });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/recurring/apply-due', () => {
  it('materializes overdue transactions with correct status', async () => {
    await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Apply Due Test',
        amount: 100,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        currency: 'USD',
      },
    });
    const res = await inject({ method: 'POST', url: '/api/recurring/apply-due', payload: { through: '2026-07-15' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('count');
    expect(res.json().count).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid through date (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/recurring/apply-due', payload: { through: 'not-a-date' } });
    expect(res.statusCode).toBe(422);
  });
});
