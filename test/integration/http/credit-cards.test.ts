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

describe('POST /api/credit-cards/:name/purchases', () => {
  it('records a purchase and joins the cycle bill (201)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Purchase Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const res = await inject({
      method: 'POST',
      url: `/api/credit-cards/${encodeURIComponent('Purchase Card')}/purchases`,
      payload: {
        description: 'REST card purchase',
        amount: 42,
        type: 'expense',
        date: '2026-06-05',
        idempotencyKey: 'rest-card-purchase',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transaction).toHaveProperty('billId');
    expect(res.json().transaction.cardId).toBeDefined();
  });

  it('is idempotent — replay returns 200 with created: false', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Idempotent Purchase Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const url = `/api/credit-cards/${encodeURIComponent('Idempotent Purchase Card')}/purchases`;
    const payload = {
      description: 'REST idempotent purchase',
      amount: 15,
      type: 'expense',
      date: '2026-06-05',
      idempotencyKey: 'rest-idempotent-card-purchase',
    };
    const first = await inject({ method: 'POST', url, payload });
    expect(first.statusCode).toBe(201);
    const replay = await inject({ method: 'POST', url, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);
  });

  it('rejects invalid body (422)', async () => {
    // Body schema validation runs before the card is ever looked up, so a placeholder path
    // segment is enough — this never needs a real card to fail with 422.
    const res = await inject({ method: 'POST', url: '/api/credit-cards/placeholder/purchases', payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for an unknown card in the path', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/credit-cards/nonexistent-purchase-card-xyz/purchases',
      payload: { description: 'Ghost card', amount: 10, type: 'expense', idempotencyKey: 'rest-ghost-card' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an account field instead of silently ignoring it (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Purchase Card Account Bank', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Strict Purchase Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const res = await inject({
      method: 'POST',
      url: `/api/credit-cards/${encodeURIComponent('Strict Purchase Card')}/purchases`,
      payload: {
        description: 'Should be rejected',
        amount: 10,
        type: 'expense',
        date: '2026-06-05',
        account: 'Purchase Card Account Bank',
        idempotencyKey: 'rest-card-purchase-with-account',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an explicitly empty category (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Empty Category Purchase Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const res = await inject({
      method: 'POST',
      url: `/api/credit-cards/${encodeURIComponent('Empty Category Purchase Card')}/purchases`,
      payload: {
        description: 'Empty category',
        amount: 10,
        type: 'expense',
        date: '2026-06-05',
        category: '',
        idempotencyKey: 'rest-card-purchase-empty-category',
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an explicitly empty subCategory (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Empty SubCategory Purchase Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const res = await inject({
      method: 'POST',
      url: `/api/credit-cards/${encodeURIComponent('Empty SubCategory Purchase Card')}/purchases`,
      payload: {
        description: 'Empty subCategory',
        amount: 10,
        type: 'expense',
        date: '2026-06-05',
        subCategory: '',
        idempotencyKey: 'rest-card-purchase-empty-subcategory',
      },
    });
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
      url: '/api/credit-cards/FullDelCard/purchases',
      payload: {
        description: 'Del card purchase',
        amount: 100,
        type: 'expense',
        date: '2026-06-05',
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
