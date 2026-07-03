import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/bills', () => {
  it('returns a bill for an existing card', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'BillPayer', type: 'checking', currency: 'USD', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'BillCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'BillPayer' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Bill charge',
        amount: 50,
        type: 'expense',
        date: '2026-06-05',
        idempotencyKey: 'bill-chg-1',
        card: 'BillCard',
      },
    });
    const res = await inject({ method: 'GET', url: '/api/bills?card=BillCard&month=6&year=2026' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('bill');
    expect(res.json().bill).toHaveProperty('id');
  });

  it('returns note on transaction rows', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'NoteBillPayer', type: 'checking', currency: 'USD', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'NoteBillCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'NoteBillPayer' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Note bill tx',
        amount: 42,
        type: 'expense',
        date: '2026-06-05',
        card: 'NoteBillCard',
        idempotencyKey: 'note-bill-1',
        note: 'warranty',
      },
    });
    const res = await inject({ method: 'GET', url: '/api/bills?card=NoteBillCard&month=6&year=2026' });
    expect(res.json().transactions.some((tx: { note?: string }) => tx.note === 'warranty')).toBe(true);
  });

  it('coerces string month/year', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'CoercePayer', type: 'checking', currency: 'USD', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'CoerceCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'CoercePayer' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Coerce charge',
        amount: 25,
        type: 'expense',
        date: '2026-06-05',
        card: 'CoerceCard',
        idempotencyKey: 'coerce-chg',
      },
    });
    const res = await inject({ method: 'GET', url: '/api/bills?card=CoerceCard&month=6&year=2026' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects month out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/bills?card=X&month=13&year=2026' });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for unknown card bill', async () => {
    const res = await inject({ method: 'GET', url: '/api/bills?card=NonexistentBillCard&month=1&year=2026' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/bills/pay', () => {
  it('pays a bill, debits payer, credits card account', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'PayBillAcc', type: 'checking', currency: 'USD', initialBalance: 5000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'PayBillCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'PayBillAcc' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Charge',
        amount: 300,
        type: 'expense',
        date: '2026-06-05',
        idempotencyKey: 'pay-bill-chg',
        card: 'PayBillCard',
      },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/bills/pay',
      payload: { card: 'PayBillCard', month: 6, year: 2026, account: 'PayBillAcc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('paid');
    const balances = await inject({ method: 'GET', url: '/api/accounts/balances?account=PayBillAcc' });
    expect(balances.json()[0].balance).toBe(4700);
    const cardBal = await inject({ method: 'GET', url: '/api/accounts/balances?account=Card%3A%20PayBillCard' });
    expect(cardBal.json()[0].balance).toBe(0);
  });

  it('pay_bill without account and without card default returns 422', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'NoDefaultCard', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'No def charge',
        amount: 50,
        type: 'expense',
        date: '2026-06-05',
        card: 'NoDefaultCard',
        idempotencyKey: 'nodef-chg',
      },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/bills/pay',
      payload: { card: 'NoDefaultCard', month: 6, year: 2026 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('pay_bill with currency mismatch returns 422', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'BRLMismatchAcc', type: 'checking', currency: 'BRL', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'USDMismatchCard', closingDay: 28, dueDay: 5, currency: 'USD' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Mismatch chg',
        amount: 25,
        type: 'expense',
        date: '2026-06-05',
        card: 'USDMismatchCard',
        idempotencyKey: 'mismatch-chg',
      },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/bills/pay',
      payload: { card: 'USDMismatchCard', month: 6, year: 2026, account: 'BRLMismatchAcc' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for unknown bill', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/bills/pay',
      payload: { card: 'Nonexistent Pay Card', month: 1, year: 2026 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/bills/revert', () => {
  it('reverts a paid bill: closes it, deletes the transfer, restores balances', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'RevertBillAcc', type: 'checking', currency: 'USD', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'RevertBillCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'RevertBillAcc' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Revert charge',
        amount: 300,
        type: 'expense',
        date: '2026-06-05',
        idempotencyKey: 'revert-bill-chg',
        card: 'RevertBillCard',
      },
    });
    const paid = await inject({
      method: 'POST',
      url: '/api/bills/pay',
      payload: { card: 'RevertBillCard', month: 6, year: 2026, account: 'RevertBillAcc' },
    });
    expect(paid.json().status).toBe('paid');

    const reverted = await inject({
      method: 'POST',
      url: '/api/bills/revert',
      payload: { card: 'RevertBillCard', month: 6, year: 2026 },
    });
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json().status).toBe('closed');
    expect(reverted.json().paymentTransactionId).toBeFalsy();

    const balances = await inject({ method: 'GET', url: '/api/accounts/balances?account=RevertBillAcc' });
    expect(balances.json()[0].balance).toBe(1000);
  });

  it('reverting a bill that is not paid is a no-op success', async () => {
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'NoopRevertCard', closingDay: 10, dueDay: 20, currency: 'USD' },
    });
    await inject({
      method: 'POST',
      url: '/api/transactions',
      payload: {
        description: 'Noop revert charge',
        amount: 20,
        type: 'expense',
        date: '2026-06-05',
        idempotencyKey: 'noop-revert-chg',
        card: 'NoopRevertCard',
      },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/bills/revert',
      payload: { card: 'NoopRevertCard', month: 6, year: 2026 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('open');
  });

  it('returns 404 for unknown bill', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/bills/revert',
      payload: { card: 'Nonexistent Revert Card', month: 1, year: 2026 },
    });
    expect(res.statusCode).toBe(404);
  });
});
