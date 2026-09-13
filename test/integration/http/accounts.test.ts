import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject, getDeps } = setupHttpTest();

describe('GET /api/accounts', () => {
  it('lists seeded accounts', async () => {
    const res = await inject({ method: 'GET', url: '/api/accounts' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('filters by type', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Filter Checking', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Filter Savings', type: 'savings', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({ method: 'GET', url: '/api/accounts?type=savings' });
    expect(res.statusCode).toBe(200);
    const accounts = res.json() as Array<{ type: string }>;
    expect(accounts.every((a) => a.type === 'savings')).toBe(true);
  });

  it('rejects invalid type (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/accounts?type=bogus' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty('error.code', 'validation');
  });
});

describe('POST /api/accounts', () => {
  it('creates an account (201) — via the functional-core-imperative-shell write path (ADR-021)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Test Checking', type: 'checking', currency: 'USD', initialBalance: 100 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty('id');
    // `version` is the applier's internal optimistic-concurrency token — never on the wire.
    expect(res.json()).not.toHaveProperty('version');
  });

  it('rejects duplicate name (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Dup Account', type: 'savings', currency: 'USD', initialBalance: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name');
  });

  it('rejects invalid body (422)', async () => {
    const res = await inject({ method: 'POST', url: '/api/accounts', payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it('rejects credit type (422)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Bad Credit', type: 'credit', currency: 'USD', initialBalance: 0 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toHaveProperty('error.code', 'validation');
  });
});

describe('PATCH /api/accounts/:name', () => {
  it('updates name and initialBalance', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Patchable', type: 'checking', currency: 'USD', initialBalance: 42 },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/accounts/Patchable',
      payload: { newName: 'Patched', initialBalance: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Patched');
    expect(res.json().initialBalance).toBe(500);
  });

  it('allows type + currency change when no transactions', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'TypeChange', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/accounts/TypeChange',
      payload: { type: 'savings', currency: 'BRL' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().type).toBe('savings');
    expect(res.json().currency).toBe('BRL');
  });

  it('blocks type change when transactions exist (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'TypeBlock', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Lock type',
        amount: 5,
        date: '2026-06-01',
        account: 'TypeBlock',
      },
    });
    const res = await inject({ method: 'PATCH', url: '/api/accounts/TypeBlock', payload: { type: 'savings' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.issues[0]).toContain('type cannot be changed');
  });

  it('blocks currency change when account is a card payer (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'CurBlockPayer', type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'CurBlockCard', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'CurBlockPayer' },
    });
    const res = await inject({ method: 'PATCH', url: '/api/accounts/CurBlockPayer', payload: { currency: 'USD' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.issues[0]).toContain('credit card payment account');
  });

  it('blocks currency change when recurring rules reference account (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'CurBlockRec', type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Lock cur',
        amount: 50,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        account: 'CurBlockRec',
        currency: 'BRL',
      },
    });
    const res = await inject({ method: 'PATCH', url: '/api/accounts/CurBlockRec', payload: { currency: 'USD' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.issues[0]).toContain('recurring rules');
  });

  it('rejects setting type to credit (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'NoCredit', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({ method: 'PATCH', url: '/api/accounts/NoCredit', payload: { type: 'credit' } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects updating a credit account (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'CreditUpdPayer', type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'CreditUpdCard', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'CreditUpdPayer' },
    });
    const res = await inject({
      method: 'PATCH',
      url: '/api/accounts/Card%3A%20CreditUpdCard',
      payload: { initialBalance: 999 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects rename to existing name (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'RenameA', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'RenameB', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({ method: 'PATCH', url: '/api/accounts/RenameA', payload: { newName: 'RenameB' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty('error.code', 'duplicate_name');
  });

  it('returns 404 for unknown account', async () => {
    const res = await inject({ method: 'PATCH', url: '/api/accounts/nonexistent-xyz-999', payload: { newName: 'X' } });
    expect(res.statusCode).toBe(404);
  });

  it('no-op returns account unchanged', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'NoopAcct', type: 'checking', currency: 'USD', initialBalance: 42 },
    });
    const res = await inject({ method: 'PATCH', url: '/api/accounts/NoopAcct', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('NoopAcct');
    expect(res.json().initialBalance).toBe(42);
  });
});

describe('DELETE /api/accounts/:name', () => {
  it('deletes an unused account', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'Deletable', type: 'wallet', currency: 'USD', initialBalance: 0 },
    });
    const res = await inject({ method: 'DELETE', url: '/api/accounts/Deletable' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('deleted', true);
  });

  it('blocked when transactions reference it (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'DelTxBlock', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Block del',
        amount: 5,
        date: '2026-06-01',
        account: 'DelTxBlock',
      },
    });
    const res = await inject({ method: 'DELETE', url: '/api/accounts/DelTxBlock' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('in_use');
    expect(res.json().error.references.transactions).toBeGreaterThanOrEqual(1);
  });

  it('blocked when recurring rule references it (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'DelRecBlock', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/recurring',
      payload: {
        description: 'Block del rec',
        amount: 50,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-07-01',
        account: 'DelRecBlock',
        currency: 'USD',
      },
    });
    const res = await inject({ method: 'DELETE', url: '/api/accounts/DelRecBlock' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.references.recurring).toBeGreaterThanOrEqual(1);
  });

  it('blocked when account is a card payer (409)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'DelCardBlock', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'DelBlockCard', closingDay: 10, dueDay: 20, currency: 'USD', paymentAccount: 'DelCardBlock' },
    });
    const res = await inject({ method: 'DELETE', url: '/api/accounts/DelCardBlock' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.references.cards).toBeGreaterThanOrEqual(1);
  });

  it('rejects deleting a credit account (422)', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'DelCreditPayer', type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/credit-cards',
      payload: { name: 'DelCreditCard', closingDay: 10, dueDay: 20, currency: 'BRL', paymentAccount: 'DelCreditPayer' },
    });
    const res = await inject({ method: 'DELETE', url: '/api/accounts/Card%3A%20DelCreditCard' });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for unknown account', async () => {
    const res = await inject({ method: 'DELETE', url: '/api/accounts/nonexistent-xyz-999' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/accounts/balances', () => {
  it('returns derived balances reflecting transactions', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'BalanceAcct', type: 'checking', currency: 'USD', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/income',
      payload: {
        description: 'Income',
        amount: 500,
        date: '2026-06-01',
        account: 'BalanceAcct',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Expense',
        amount: 200,
        date: '2026-06-01',
        account: 'BalanceAcct',
      },
    });
    const res = await inject({ method: 'GET', url: '/api/accounts/balances?account=BalanceAcct' });
    expect(res.statusCode).toBe(200);
    const { balances } = res.json() as {
      balances: Array<{ balance: number; income: number; expenses: number }>;
    };
    expect(balances[0]!.balance).toBe(1300);
    expect(balances[0]!.income).toBe(500);
    expect(balances[0]!.expenses).toBe(200);
  });

  it('pending excluded from balance, included in projectedBalance', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'ProjAcct', type: 'checking', currency: 'USD', initialBalance: 1000 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Pending exp',
        amount: 300,
        date: '2026-06-15',
        account: 'ProjAcct',
        status: 'pending',
      },
    });
    const noProj = await inject({ method: 'GET', url: '/api/accounts/balances?account=ProjAcct' });
    expect(noProj.json().balances[0].balance).toBe(1000);
    expect(noProj.json().balances[0].projectedBalance).toBeUndefined();
    const withProj = await inject({
      method: 'GET',
      url: '/api/accounts/balances?account=ProjAcct&projectedAsOf=2026-06-30',
    });
    expect(withProj.json().balances[0].balance).toBe(1000);
    expect(withProj.json().balances[0].projectedBalance).toBe(700);
  });

  it('rejects invalid projectedAsOf (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/accounts/balances?projectedAsOf=bad' });
    expect(res.statusCode).toBe(422);
  });

  it('valuation (ADR-026): converts a non-base-currency balance and sums a consolidated net worth', async () => {
    // Pins deps.clock so staleness (now - asOf vs. the 24h fiat window) is deterministic — a
    // real Date.now() call here would flip `stale` once wall-clock time drifts past the window.
    const RATE_ASOF = '2026-08-10T10:00:00.000Z';
    const FIXED_NOW = new Date('2026-08-10T12:00:00.000Z');
    const deps = getDeps();
    const originalClock = deps.clock;
    deps.clock = () => FIXED_NOW;

    try {
      await inject({
        method: 'POST',
        url: '/api/settings/base-currency',
        payload: { baseCurrency: 'USD' },
      });
      await inject({
        method: 'POST',
        url: '/api/exchange-rates',
        payload: { from: 'BRL', to: 'USD', rate: 0.2, asOf: RATE_ASOF },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'ValUsdAcct', type: 'checking', currency: 'USD', initialBalance: 100 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'ValBrlAcct', type: 'checking', currency: 'BRL', initialBalance: 500 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'ValBtcAcct', type: 'checking', currency: 'BTC', initialBalance: 1 },
      });

      type BalancesBody = {
        balances: Array<{ id: string; converted?: { value: number; rate: number; stale: boolean } }>;
        consolidatedNetWorth: { baseCurrency: string; total: number; excluded: string[] };
      };
      // Filtered per account so other accounts created elsewhere in this suite don't pollute the total.
      const usdRes = await inject({ method: 'GET', url: '/api/accounts/balances?account=ValUsdAcct' });
      const brlRes = await inject({ method: 'GET', url: '/api/accounts/balances?account=ValBrlAcct' });
      const btcRes = await inject({ method: 'GET', url: '/api/accounts/balances?account=ValBtcAcct' });
      expect(usdRes.statusCode).toBe(200);
      const usdBody = usdRes.json() as BalancesBody;
      const brlBody = brlRes.json() as BalancesBody;
      const btcBody = btcRes.json() as BalancesBody;

      expect(usdBody.balances[0]!.converted).toEqual({
        baseCurrency: 'USD',
        value: 100,
        rate: 1,
        asOf: FIXED_NOW.toISOString(),
        stale: false,
      });
      expect(usdBody.consolidatedNetWorth).toEqual({ baseCurrency: 'USD', total: 100, excluded: [] });

      expect(brlBody.balances[0]!.converted).toEqual({
        baseCurrency: 'USD',
        value: 100,
        rate: 0.2,
        asOf: RATE_ASOF,
        stale: false,
      });
      expect(brlBody.consolidatedNetWorth).toEqual({ baseCurrency: 'USD', total: 100, excluded: [] });

      expect(btcBody.balances[0]!.converted).toBeUndefined();
      expect(btcBody.consolidatedNetWorth).toEqual({
        baseCurrency: 'USD',
        total: 0,
        excluded: [btcBody.balances[0]!.id],
      });
    } finally {
      deps.clock = originalClock;
    }
  });
});
