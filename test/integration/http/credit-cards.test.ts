import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/credit-cards', () => {
  it('lists credit cards', async () => {
    const res = await inject({ method: 'GET', url: '/api/credit-cards' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('POST /api/credit-cards', () => {
  it('creates a credit card and auto-creates internal credit account (201)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Card Payer', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Test Visa', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'Card Payer' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('accountId');
    expect(res.json()).toHaveProperty('paymentAccountId');
    const accounts = await inject({ method: 'GET', url: '/api/accounts?type=credit' });
    const creditAccounts = accounts.json() as Array<{ name: string }>;
    expect(creditAccounts.some((a) => a.name === 'Card: Test Visa')).toBe(true);
  });

  it('rejects duplicate name (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Card Payer 2', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Dup Card', closingDay: 5, dueDay: 15, currency: 'USD', paymentAccount: 'Card Payer 2' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Dup Card', closingDay: 5, dueDay: 15, currency: 'USD', paymentAccount: 'Card Payer 2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name');
  });

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/credit-cards', payload: {} });
    expect(res.statusCode).toBe(422);
  });
});

describe('DELETE /api/credit-cards/:name', () => {
  it('dry-run returns counts, confirm deletes everything', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'DelCardBank', type: 'checking', currency: 'USD', initialBalance: 2000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'FullDelCard', closingDay: 28, dueDay: 5, currency: 'USD', paymentAccount: 'DelCardBank' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Del card purchase',
        amount: 100,
        type: 'expense',
        date: '2026-06-05',
        card: 'FullDelCard',
        idempotencyKey: 'del-card-purchase',
      },
    });
    const dryRun = await inject({ method: 'DELETE', url: '/api/credit-cards/FullDelCard' });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json().dryRun).toBe(true);
    expect(dryRun.json().wouldDelete.transactions).toBeGreaterThanOrEqual(1);
    const confirm = await inject({ method: 'DELETE', url: '/api/credit-cards/FullDelCard?confirm=true' });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().deleted).toBe(true);
  });

  it('returns 404 for unknown card', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/credit-cards/nonexistent-card-xyz?confirm=true' });
    expect(res.statusCode).toBe(404);
  });
});
