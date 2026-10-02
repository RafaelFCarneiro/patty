import { describe, expect, it } from 'vitest';
import { setupHttpTest } from './setup.js';

const { inject } = setupHttpTest();

describe('GET /api/aggregate', () => {
  it('groups by category with correct sums', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggCatAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Agg food',
        amount: 200,
        date: '2025-03-15',
        account: 'AggCatAcct',
        category: 'Food',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Agg transport',
        amount: 50,
        date: '2025-03-15',
        account: 'AggCatAcct',
        category: 'Transport',
      },
    });
    const res = await inject({
      method: 'GET',
      url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggCatAcct',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().groupBy).toBe('category');
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD');
    const foodRow = usd.rows.find((r: { label: string }) => r.label === 'Food');
    expect(foodRow.value).toBe(200);
  });

  it('excludes transfers and pending', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggExclAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggExclAcct2', type: 'savings', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Excl food',
        amount: 200,
        date: '2025-03-15',
        account: 'AggExclAcct',
        category: 'Food',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Excl transport',
        amount: 50,
        date: '2025-03-15',
        account: 'AggExclAcct',
        category: 'Transport',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/transfers',
      payload: {
        from: 'AggExclAcct',
        to: 'AggExclAcct2',
        amount: 100,
        date: '2025-03-15',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Excl pending',
        amount: 999,
        date: '2025-03-15',
        account: 'AggExclAcct',
        category: 'Food',
        status: 'pending',
      },
    });
    const res = await inject({
      method: 'GET',
      url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggExclAcct',
    });
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD');
    const totalAmount = usd.rows.reduce((sum: number, r: { value: number }) => sum + r.value, 0);
    expect(totalAmount).toBe(250);
  });

  it('groups by tag — multi-tagged transaction in both groups', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggTagAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-work' } });
    await inject({ method: 'POST', url: '/api/tags', payload: { name: 'agg-travel' } });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Multi tag',
        amount: 30,
        date: '2025-03-15',
        account: 'AggTagAcct',
        tags: ['agg-work', 'agg-travel'],
      },
    });
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=tag&month=3&year=2025&account=AggTagAcct' });
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD');
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-work')).toBeDefined();
    expect(usd.rows.find((r: { label: string }) => r.label === 'agg-travel')).toBeDefined();
  });

  it('limits per currency, not globally', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggLimitUSD', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggLimitBRL', type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'USD exp1',
        amount: 100,
        date: '2025-03-15',
        account: 'AggLimitUSD',
        category: 'Food',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'USD exp2',
        amount: 50,
        date: '2025-03-15',
        account: 'AggLimitUSD',
        category: 'Transport',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'BRL exp1',
        amount: 10,
        date: '2025-03-15',
        account: 'AggLimitBRL',
        category: 'Food',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'BRL exp2',
        amount: 5,
        date: '2025-03-15',
        account: 'AggLimitBRL',
        category: 'Transport',
      },
    });
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category&month=3&year=2025&limit=1' });
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD');
    const brl = res.json().currencies.find((c: { currency: string }) => c.currency === 'BRL');
    expect(usd).toBeDefined();
    expect(brl).toBeDefined();
    expect(usd.rows).toHaveLength(1);
    expect(brl.rows).toHaveLength(1);
  });

  it('groups by month over date range', async () => {
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'AggMonthAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Feb exp',
        amount: 75,
        date: '2025-02-15',
        account: 'AggMonthAcct',
        category: 'Food',
      },
    });
    await inject({
      method: 'POST',
      url: '/api/accounts/expenses',
      payload: {
        description: 'Mar exp',
        amount: 100,
        date: '2025-03-15',
        account: 'AggMonthAcct',
        category: 'Food',
      },
    });
    const res = await inject({
      method: 'GET',
      url: '/api/aggregate?groupBy=month&from=2025-02-01&to=2025-04-01&account=AggMonthAcct&sort=asc',
    });
    const usd = res.json().currencies.find((c: { currency: string }) => c.currency === 'USD');
    expect(usd.rows.length).toBeGreaterThanOrEqual(2);
    const months = usd.rows.map((r: { key: string }) => r.key);
    expect(months[0] < months[months.length - 1]).toBe(true);
  });

  it("counts a month's last day and excludes the 1st of the next month, including across December", async () => {
    const account = 'AggBoundaryAcct';
    await inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: account, type: 'checking', currency: 'USD', initialBalance: 0 },
    });
    const seed = (description: string, amount: number, date: string) =>
      inject({ method: 'POST', url: '/api/accounts/expenses', payload: { description, amount, date, account } });
    await seed('Agg boundary sep last', 30, '2025-09-30');
    await seed('Agg boundary oct first', 1, '2025-10-01');
    await seed('Agg boundary dec last', 31, '2024-12-31');
    await seed('Agg boundary jan first', 2, '2025-01-01');
    const usdTotal = async (period: string): Promise<number> => {
      const res = await inject({ method: 'GET', url: `/api/aggregate?groupBy=category&${period}&account=${account}` });
      expect(res.statusCode).toBe(200);
      return res.json().currencies.find((c: { currency: string }) => c.currency === 'USD').total;
    };
    expect(await usdTotal('month=9&year=2025')).toBe(30);
    expect(await usdTotal('month=12&year=2024')).toBe(31);
    expect(await usdTotal('from=2025-09-01&to=2025-10-01')).toBe(30);
  });

  it('rejects missing period (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/aggregate?groupBy=category' });
    expect(res.statusCode).toBe(422);
  });

  it('rejects missing groupBy (422)', async () => {
    const res = await inject({ method: 'GET', url: '/api/aggregate?month=6&year=2026' });
    expect(res.statusCode).toBe(422);
  });

  describe('displayCurrency', () => {
    type AggBody = {
      groupBy: string;
      metric: string;
      currencies: Array<{ currency: string; total: number; rows: unknown[] }>;
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
        payload: { name: 'AggDcOmitAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc omit',
          amount: 40,
          date: '2025-03-15',
          account: 'AggDcOmitAcct',
        },
      });
      const res = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggDcOmitAcct',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('converted');
    });

    it('metric=sum + displayCurrency: converts and sums the per-currency block totals, lines unchanged', async () => {
      await inject({
        method: 'POST',
        url: '/api/exchange-rates',
        payload: { from: 'BRL', to: 'USD', rate: 0.2, asOf: '2025-03-01T00:00:00.000Z' },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'AggDcUsdAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'AggDcBrlAcct', type: 'checking', currency: 'BRL', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc usd',
          amount: 100,
          date: '2025-03-15',
          account: 'AggDcUsdAcct',
        },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc brl',
          amount: 500,
          date: '2025-03-15',
          account: 'AggDcBrlAcct',
        },
      });

      const withoutConversion = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=account&month=3&year=2025',
      });
      const withConversion = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=account&month=3&year=2025&displayCurrency=USD',
      });
      expect(withConversion.statusCode).toBe(200);
      const withoutBody = withoutConversion.json() as AggBody;
      const withBody = withConversion.json() as AggBody;

      expect(withBody.currencies).toEqual(withoutBody.currencies);
      // Sums every USD/BRL block total across this suite's own runs (shared DB) — assert a floor,
      // not an exact total: 100 + 500*0.2 = 200 from this test's own fixtures alone.
      expect(withBody.converted?.displayCurrency).toBe('USD');
      expect(withBody.converted?.excluded).toEqual([]);
      expect(withBody.converted?.total).toBeGreaterThanOrEqual(200);
    });

    it('a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'AggDcBtcAcct', type: 'checking', currency: 'BTC', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc btc',
          amount: 1,
          date: '2025-03-15',
          account: 'AggDcBtcAcct',
        },
      });
      const res = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=account&month=3&year=2025&displayCurrency=USD',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AggBody;
      expect(body.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    });

    it('converts the currency block total, not the sum of rows truncated by limit', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'AggDcLimitAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
      });
      // limit=1 below returns only one row — the block's own `total` (and the converted grand
      // total) must still reflect both categories.
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc limit food',
          amount: 100,
          date: '2025-03-15',
          account: 'AggDcLimitAcct',
          category: 'Food',
        },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc limit transport',
          amount: 40,
          date: '2025-03-15',
          account: 'AggDcLimitAcct',
          category: 'Transport',
        },
      });
      const res = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=category&month=3&year=2025&account=AggDcLimitAcct&limit=1&displayCurrency=USD',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AggBody;
      const usd = body.currencies.find((c) => c.currency === 'USD')!;
      expect(usd.rows).toHaveLength(1);
      expect(usd.total).toBe(140);
      expect(body.converted?.total).toBe(140);
    });

    it('metric=count: displayCurrency is a no-op — no converted block even when supplied', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'AggDcCountAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc count',
          amount: 20,
          date: '2025-03-15',
          account: 'AggDcCountAcct',
        },
      });
      const res = await inject({
        method: 'GET',
        url:
          '/api/aggregate?groupBy=category&metric=count&month=3&year=2025&account=AggDcCountAcct&displayCurrency=USD',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('converted');
    });

    it('metric=avg: displayCurrency is a no-op — no converted block even when supplied', async () => {
      await inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'AggDcAvgAcct', type: 'checking', currency: 'USD', initialBalance: 0 },
      });
      await inject({
        method: 'POST',
        url: '/api/accounts/expenses',
        payload: {
          description: 'Agg dc avg',
          amount: 20,
          date: '2025-03-15',
          account: 'AggDcAvgAcct',
        },
      });
      const res = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=category&metric=avg&month=3&year=2025&account=AggDcAvgAcct&displayCurrency=USD',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('converted');
    });

    it('rejects an unknown displayCurrency (422)', async () => {
      const res = await inject({
        method: 'GET',
        url: '/api/aggregate?groupBy=category&month=3&year=2025&displayCurrency=EUR',
      });
      expect(res.statusCode).toBe(422);
    });
  });
});
