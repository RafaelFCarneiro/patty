import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject, getDeps } = setupHttpTest();

describe('GET /api/summary', () => {
  it('returns spending summary excluding pending', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'SumAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Sum exp',
        amount: 100,
        date: '2026-05-01',
        account: 'SumAcct',
        idempotencyKey: 'sum-exp',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Sum pending',
        amount: 999,
        date: '2026-05-01',
        account: 'SumAcct',
        status: 'pending',
        idempotencyKey: 'sum-pend',
      },
    });
    const res = await inject({ method: 'GET', url: '/api/summary?month=5&year=2026' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('period');
    const usd = res.json().currencies?.find((c: { currency: string }) => c.currency === 'USD');
    expect(usd).toBeDefined();
    expect(usd!.expenses).toBe(100);
  });

  it('coerces string month/year', async () => {
    const res = await inject({ method: 'GET', url: '/api/summary?month=6&year=2026' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects month out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/summary?month=0&year=2026' });
    expect(res.statusCode).toBe(422);
  });

  it('rejects year out of range (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/summary?month=1&year=1999' });
    expect(res.statusCode).toBe(422);
  });

  describe('displayCurrency', () => {
    // Pins deps.clock so staleness/asOf is deterministic, same pattern as the account valuation test.
    // Kept on/after every fixture transaction's date — deps.clock also drives the date-aware
    // effective/pending default, and a transaction dated after "now" would default to pending
    // and drop out of the summary entirely.
    const RATE_ASOF = '2026-08-10T10:00:00.000Z';
    const FIXED_NOW = new Date('2026-08-10T12:00:00.000Z');

    type SummaryBody = {
      period: { month: number; year: number };
      currencies: Array<{ currency: string; expenses: number }>;
      converted?: {
        displayCurrency: string;
        total: number;
        stale: boolean;
        asOf: string | null;
        excluded: Array<{ currency: string; reason: string }>;
      };
    };

    it('omitted displayCurrency: response has no converted block (regression pin)', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'DcOmitAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Dc omit',
          amount: 40,
          date: '2026-07-01',
          account: 'DcOmitAcct',
          idempotencyKey: 'dc-omit-1',
        },
      });
      const res = await inject({ method: 'GET', url: '/api/summary?month=7&year=2026' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('converted');
    });

    // Each remaining case uses its own month — GET /api/summary has no account filter, so
    // transactions from an earlier case in this shared-DB suite would otherwise leak into
    // the same currency's total (unlike the balances endpoint, which supports ?account=).

    it('provided displayCurrency: converts + sums expenses, per-currency lines unchanged', async () => {
      const deps = getDeps();
      const originalClock = deps.clock;
      deps.clock = () => FIXED_NOW;

      try {
        await inject({
          method: 'POST',
          url: '/api/exchange-rates',
          payload: { from: 'BRL', to: 'USD', rate: 0.2, asOf: RATE_ASOF },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts',
          payload: { name: 'DcUsdAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts',
          payload: { name: 'DcBrlAcct', type: 'checking', currency: 'BRL', initialBalance: 0 },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts/expenses',
          payload: {
            description: 'Dc usd',
            amount: 100,
            date: '2026-08-02',
            account: 'DcUsdAcct',
            idempotencyKey: 'dc-usd-1',
          },
        });
        await inject({
          method: 'POST',
          url: '/api/accounts/expenses',
          payload: {
            description: 'Dc brl',
            amount: 500,
            date: '2026-08-02',
            account: 'DcBrlAcct',
            idempotencyKey: 'dc-brl-1',
          },
        });

        const withoutConversion = await inject({ method: 'GET', url: '/api/summary?month=8&year=2026' });
        const withConversion = await inject({
          method: 'GET',
          url: '/api/summary?month=8&year=2026&displayCurrency=USD',
        });
        expect(withConversion.statusCode).toBe(200);
        const withoutBody = withoutConversion.json() as SummaryBody;
        const withBody = withConversion.json() as SummaryBody;

        expect(withBody.currencies).toEqual(withoutBody.currencies);
        // The query string also carries displayCurrency — period must not leak it (regression).
        expect(withBody.period).toEqual({ month: 8, year: 2026 });
        // USD identity 100 + BRL 500 * 0.2 = 100 → 200
        expect(withBody.converted).toEqual({
          displayCurrency: 'USD',
          total: 200,
          stale: false,
          asOf: RATE_ASOF,
          excluded: [],
        });
      } finally {
        deps.clock = originalClock;
      }
    });

    it('a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'DcBtcAcct', type: 'checking', currency: 'BTC', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Dc btc',
          amount: 1,
          date: '2026-01-03',
          account: 'DcBtcAcct',
          idempotencyKey: 'dc-btc-1',
        },
      });
      const res = await inject({ method: 'GET', url: '/api/summary?month=1&year=2026&displayCurrency=USD' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SummaryBody;
      expect(body.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    });

    it('an income-only currency (zero expenses, no rate on file) is not excluded and does not flip stale', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'DcBtcIncomeAcct', type: 'checking', currency: 'BTC', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/income',
        payload: {
          description: 'Dc btc income',
          amount: 1,
          date: '2026-02-03',
          account: 'DcBtcIncomeAcct',
          idempotencyKey: 'dc-btc-income-1',
        },
      });
      const res = await inject({ method: 'GET', url: '/api/summary?month=2&year=2026&displayCurrency=USD' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SummaryBody;
      expect(body.converted?.excluded).toEqual([]);
      expect(body.converted?.stale).toBe(false);
    });

    it('rejects an unknown displayCurrency (422)', async () => {
      const res = await inject({ method: 'GET', url: '/api/summary?month=7&year=2026&displayCurrency=EUR' });
      expect(res.statusCode).toBe(422);
    });
  });
});
