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

describe('PATCH /api/credit-cards/:name', () => {
  it('renames a card and its internal account atomically (200)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Rename Me', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/Rename%20Me',
      payload: { newName: 'Renamed Card' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed Card');

    const cards = await inject({ method: 'GET', url: '/api/credit-cards' });
    const cardNames = (cards.json() as Array<{ name: string }>).map((c) => c.name);
    expect(cardNames).toContain('Renamed Card');
    expect(cardNames).not.toContain('Rename Me');

    const accounts = await inject({ method: 'GET', url: '/api/accounts?type=credit' });
    const accountNames = (accounts.json() as Array<{ name: string }>).map((a) => a.name);
    expect(accountNames).toContain('Card: Renamed Card');
    expect(accountNames).not.toContain('Card: Rename Me');
  });

  it('rejects a duplicate new name (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Existing Card', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Card To Rename', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/Card%20To%20Rename',
      payload: { newName: 'Existing Card' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name');
  });

  it('updates limit/closingDay/dueDay without touching the internal account (200)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Field Update Card', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/Field%20Update%20Card',
      payload: { limit: 3000, closingDay: 15, dueDay: 25 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ limit: 3000, closingDay: 15, dueDay: 25, name: 'Field Update Card' });

    const accounts = await inject({ method: 'GET', url: '/api/accounts?type=credit' });
    const accountNames = (accounts.json() as Array<{ name: string }>).map((a) => a.name);
    expect(accountNames).toContain('Card: Field Update Card');
  });

  it('a closingDay change leaves an already-computed bill unchanged (200)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Bill Boundary Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards/purchases',
      payload: {
        description: 'Boundary purchase',
        amount: 20,
        type: 'expense',
        date: '2026-06-05',
        card: 'Bill Boundary Card',
        idempotencyKey: 'boundary-purchase',
      },
    });
    const before = await inject({
      method: 'GET',
      url: `/api/bills?card=${encodeURIComponent('Bill Boundary Card')}&month=6&year=2026`,
    });
    const closeDateBefore = before.json().bill.closeDate as string;
    const dueDateBefore = before.json().bill.dueDate as string;

    const patch = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/Bill%20Boundary%20Card',
      payload: { closingDay: 10, dueDay: 20 },
    });
    expect(patch.statusCode).toBe(200);

    const after = await inject({
      method: 'GET',
      url: `/api/bills?card=${encodeURIComponent('Bill Boundary Card')}&month=6&year=2026`,
    });
    expect(after.json().bill.closeDate).toBe(closeDateBefore);
    expect(after.json().bill.dueDate).toBe(dueDateBefore);
  });

  it('rejects a credit account as paymentAccount (422) — the #4 regression, alongside create/pay', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Guard Update Card', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/Guard%20Update%20Card',
      payload: { paymentAccount: 'Card: Guard Update Card' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty('error.code', 'validation');
  });

  it('returns 404 for unknown card', async () => {
    const res = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/nonexistent-card-xyz',
      payload: { limit: 100 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects invalid body (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Invalid Body Card', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/credit-cards/Invalid%20Body%20Card',
      payload: { closingDay: 40 },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/credit-cards/purchases', () => {
  it('records a purchase and joins the cycle bill (201)', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'Purchase Card', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/credit-cards/purchases',
      payload: {
        description: 'REST card purchase',
        amount: 42,
        type: 'expense',
        date: '2026-06-05',
        card: 'Purchase Card',
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
    const payload = {
      description: 'REST idempotent purchase',
      amount: 15,
      type: 'expense',
      date: '2026-06-05',
      card: 'Idempotent Purchase Card',
      idempotencyKey: 'rest-idempotent-card-purchase',
    };
    const first = await inject({ method: 'POST', url: '/api/credit-cards/purchases', payload });
    expect(first.statusCode).toBe(201);
    const replay = await inject({ method: 'POST', url: '/api/credit-cards/purchases', payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().created).toBe(false);
  });

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/credit-cards/purchases', payload: {} });
    expect(res.statusCode).toBe(422);
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
      url: '/api/credit-cards/purchases',
      payload: {
        description: 'Should be rejected',
        amount: 10,
        type: 'expense',
        date: '2026-06-05',
        card: 'Strict Purchase Card',
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
      url: '/api/credit-cards/purchases',
      payload: {
        description: 'Empty category',
        amount: 10,
        type: 'expense',
        date: '2026-06-05',
        card: 'Empty Category Purchase Card',
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
      url: '/api/credit-cards/purchases',
      payload: {
        description: 'Empty subCategory',
        amount: 10,
        type: 'expense',
        date: '2026-06-05',
        card: 'Empty SubCategory Purchase Card',
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
      url: '/api/credit-cards/purchases',
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
