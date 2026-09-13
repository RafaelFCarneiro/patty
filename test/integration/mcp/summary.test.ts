import { describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, ensure, makeClient } from './helpers.js';

type CurrencySummary = { currency: string; income: number; expenses: number };
type SpendingSummary = {
  period: { month: number; year: number };
  currencies: CurrencySummary[];
  converted?: { displayCurrency: string; total: number; stale: boolean; asOf: string | null; excluded: unknown[] };
};

const now = new Date();
const month = now.getMonth() + 1;
const year = now.getFullYear();
const date = toIsoDate(now);

// This suite shares one MCP server/DB across every integration test file (fileParallelism: false,
// base-currency.test.ts) — accounts get a unique per-test name (stamp) and currency_rates/
// base_currency are set explicitly, never assumed, same convention as accounts.test.ts's own
// account-valuation test.
describe('MCP integration > get_spending_summary displayCurrency', () => {
  it('omitted displayCurrency: response has no converted block (regression pin)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const accountName = `Summary Dc Omit ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: accountName, currency: 'USD' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: 'Dc omit',
          amount: 20,
          date,
          account: accountName,
        },
      });

      const result = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as SpendingSummary;
      expect(result).not.toHaveProperty('converted');
    } finally {
      await transport.close();
    }
  });

  it('provided displayCurrency: converts and sums expenses, per-currency lines unchanged', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const usdName = `Summary Dc USD ${stamp}`;
      const brlName = `Summary Dc BRL ${stamp}`;

      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() },
      });
      await callTool(client, { name: 'create_account', args: { name: usdName, currency: 'USD' } });
      await callTool(client, { name: 'create_account', args: { name: brlName, currency: 'BRL' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: 'Dc usd',
          amount: 100,
          date,
          account: usdName,
        },
      });
      await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: 'Dc brl',
          amount: 500,
          date,
          account: brlName,
        },
      });

      const withoutConversion = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as SpendingSummary;
      const withConversion = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year, displayCurrency: 'USD' },
      })) as SpendingSummary;

      expect(withConversion.currencies).toEqual(withoutConversion.currencies);
      // args also carries displayCurrency — period must not leak it (regression).
      expect(withConversion.period).toEqual({ month, year });
      ensure(withConversion.converted, 'converted block missing when displayCurrency was supplied');
      expect(withConversion.converted).toMatchObject({ displayCurrency: 'USD', stale: false, excluded: [] });
      // Includes every USD/BRL expense created across this suite's own runs (shared DB), not just
      // this test's own 100 + 500*0.2 = 200 — so assert it's at least that, not an exact total.
      expect(withConversion.converted.total).toBeGreaterThanOrEqual(200);
    } finally {
      await transport.close();
    }
  });

  it('a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const btcName = `Summary Dc BTC ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: btcName, currency: 'BTC' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: 'Dc btc',
          amount: 1,
          date,
          account: btcName,
        },
      });

      const result = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year, displayCurrency: 'USD' },
      })) as SpendingSummary;
      expect(result.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    } finally {
      await transport.close();
    }
  });

  it('an income-only currency (zero expenses, no rate on file) is not excluded', async () => {
    // USDC, not BTC: this suite shares its MCP server/DB with every other integration test file
    // (fileParallelism: false), and several of them give BTC a non-zero expense dated today with
    // no rate on file — so BTC may already legitimately sit in `excluded` regardless of this test.
    // USDC only has a USD -> USDC rate on file elsewhere (the opposite direction, which `convert`
    // never matches), so it stays untouched by this suite's other fixtures — asserting it, not the
    // whole array, keeps this test independent of file execution order.
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const usdcName = `Summary Dc USDC Income ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: usdcName, currency: 'USDC' } });
      await callTool(client, {
        name: 'add_account_income',
        args: {
          description: 'Dc usdc income',
          amount: 1,
          date,
          account: usdcName,
        },
      });

      const result = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year, displayCurrency: 'USD' },
      })) as SpendingSummary;
      expect(result.converted?.excluded).not.toContainEqual({ currency: 'USDC', reason: 'no_rate' });
    } finally {
      await transport.close();
    }
  });

  it('rejects an unknown displayCurrency at the protocol level (not a valid CurrencyCode enum member)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, { name: 'get_spending_summary', args: { month, year, displayCurrency: 'EUR' } }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});
