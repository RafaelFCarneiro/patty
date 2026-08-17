import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, ensure, makeClient } from './helpers.js';

type AggRow = { key: string; label: string; value: number; count: number; pct: number };
type CurrencyBlock = { currency: string; total: number; rows: AggRow[] };
type AggResult = {
  groupBy: string;
  metric: string;
  currencies: CurrencyBlock[];
  converted?: { displayCurrency: string; total: number; stale: boolean; asOf: string | null; excluded: unknown[] };
};

const month = 3;
const year = 2025;
const date = '2025-03-15';
const prevMonth = '2025-02-15';

describe('MCP integration > aggregate_spending', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    await callTool(client, { name: 'create_account', args: { name: 'AggAcctBRL', currency: 'BRL' } });
    await callTool(client, { name: 'create_account', args: { name: 'AggAcctBRL2', currency: 'BRL' } });
    await callTool(client, { name: 'create_account', args: { name: 'AggAcctUSD', currency: 'USD' } });
    await callTool(client, { name: 'create_tag', args: { name: 'agg-work' } });
    await callTool(client, { name: 'create_tag', args: { name: 'agg-travel' } });

    // (a) category grouping: two expenses in BRL, one in USD
    await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Agg grocery',
        amount: 200,
        date,
        account: 'AggAcctBRL',
        category: 'Food',
        idempotencyKey: 'agg-1',
      },
    });
    await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Agg bus',
        amount: 50,
        date,
        account: 'AggAcctBRL',
        category: 'Transport',
        idempotencyKey: 'agg-2',
      },
    });
    await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Agg usd sub',
        amount: 15,
        date,
        account: 'AggAcctUSD',
        category: 'Subscriptions',
        idempotencyKey: 'agg-3',
      },
    });

    // (c) transfer — must be excluded
    await callTool(client, {
      name: 'create_transfer',
      args: {
        from: 'AggAcctBRL',
        to: 'AggAcctBRL2',
        amount: 100,
        date,
        idempotencyKey: 'agg-transfer-1',
      },
    });

    // (c) pending — must be excluded
    await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Agg pending',
        amount: 999,
        date,
        account: 'AggAcctBRL',
        category: 'Food',
        status: 'pending',
        idempotencyKey: 'agg-pending-1',
      },
    });

    // (d) multi-tag transaction
    await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Agg tagged',
        amount: 30,
        date,
        account: 'AggAcctBRL',
        category: 'Transport',
        tags: ['agg-work', 'agg-travel'],
        idempotencyKey: 'agg-tag-1',
      },
    });

    // (e) previous month for time series
    await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Agg prev month',
        amount: 75,
        date: prevMonth,
        account: 'AggAcctBRL',
        category: 'Food',
        idempotencyKey: 'agg-prev-1',
      },
    });
  });

  afterAll(async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    await transport.close();
  });

  // (a) groupBy: category sums per currency with locale-resolved labels
  it('groups by category with correct sums and labels', async () => {
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctBRL' },
    })) as AggResult;
    expect(result.groupBy).toBe('category');
    expect(result.metric).toBe('sum');

    const brl = result.currencies.find((c) => c.currency === 'BRL')!;
    expect(brl).toBeDefined();
    const foodRow = brl.rows.find((r) => r.label === 'Food')!;
    expect(foodRow.value).toBe(200);
    const transportRow = brl.rows.find((r) => r.label === 'Transport')!;
    expect(transportRow).toBeDefined();
  });

  // (b) type/account filter narrows results
  it('filters by account', async () => {
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctUSD' },
    })) as AggResult;
    expect(result.currencies).toHaveLength(1);
    expect(result.currencies[0]!.currency).toBe('USD');
  });

  // (c) transfers excluded and pending excluded
  it('excludes transfers and pending', async () => {
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctBRL' },
    })) as AggResult;
    const brl = result.currencies.find((c) => c.currency === 'BRL')!;
    const totalAmount = brl.rows.reduce((sum, r) => sum + r.value, 0);
    // 200 (food) + 50 (transport) + 30 (tagged transport) = 280
    // pending 999 and transfer 100 excluded
    expect(totalAmount).toBe(280);
  });

  // (d) tag multi-counts
  it('groups by tag — multi-tagged transaction appears in both groups', async () => {
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'tag', month, year, account: 'AggAcctBRL' },
    })) as AggResult;
    const brl = result.currencies.find((c) => c.currency === 'BRL')!;
    const workRow = brl.rows.find((r) => r.label === 'agg-work');
    const travelRow = brl.rows.find((r) => r.label === 'agg-travel');
    expect(workRow).toBeDefined();
    expect(travelRow).toBeDefined();
    expect(workRow!.value).toBe(30);
    expect(travelRow!.value).toBe(30);
  });

  // (e) month time series over from/to range
  it('groups by month over date range', async () => {
    const fromDate = prevMonth;
    const toDate = '2025-04-01';
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'month', from: fromDate, to: toDate, account: 'AggAcctBRL', sort: 'asc' },
    })) as AggResult;
    const brl = result.currencies.find((c) => c.currency === 'BRL')!;
    expect(brl.rows.length).toBeGreaterThanOrEqual(2);
    const months = brl.rows.map((r) => r.key);
    expect(months[0]! < months[months.length - 1]!).toBe(true);
  });

  // (f) limit top-N per currency (not global)
  it('limits results per currency, not globally', async () => {
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, limit: 1 },
    })) as AggResult;
    // Both BRL and USD currencies should be present (not truncated by a global limit)
    const brl = result.currencies.find((c) => c.currency === 'BRL');
    const usd = result.currencies.find((c) => c.currency === 'USD');
    expect(brl).toBeDefined();
    expect(usd).toBeDefined();
    // Each currency block limited to 1 row
    expect(brl!.rows).toHaveLength(1);
    expect(usd!.rows).toHaveLength(1);
  });

  // (g) invalid groupBy rejected at boundary (zod or MCP SDK rejects before handler)
  it('rejects invalid groupBy', async () => {
    await expect(
      callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'invalid_dimension', month, year },
      }),
    ).rejects.toThrow();
  });

  // (h) locale: pt labels
  it('returns pt category labels after set_locale', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } });
    const result = (await callTool(client, {
      name: 'aggregate_spending',
      args: { groupBy: 'category', month, year, account: 'AggAcctBRL' },
    })) as AggResult;
    const brl = result.currencies.find((c) => c.currency === 'BRL')!;
    const foodRow = brl.rows.find((r) => r.key != null && r.label === 'Alimentação');
    expect(foodRow).toBeDefined();

    // restore
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
  });
});

// Feature Design 021 Phase 4 — separate describe so each test owns an isolated client/fixtures,
// same convention as get_spending_summary's own displayCurrency suite.
describe('MCP integration > aggregate_spending displayCurrency', () => {
  it('omitted displayCurrency: response has no converted block (regression pin)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const accountName = `Agg Dc Omit ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: accountName, currency: 'USD' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: { description: 'Dc omit', amount: 20, date, account: accountName, idempotencyKey: `agg-dc-omit-${stamp}` },
      });

      const result = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'category', month, year, account: accountName },
      })) as AggResult;
      expect(result).not.toHaveProperty('converted');
    } finally {
      await transport.close();
    }
  });

  it('metric=sum + displayCurrency: converts and sums the per-currency block totals, lines unchanged', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const usdName = `Agg Dc USD ${stamp}`;
      const brlName = `Agg Dc BRL ${stamp}`;

      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() },
      });
      await callTool(client, { name: 'create_account', args: { name: usdName, currency: 'USD' } });
      await callTool(client, { name: 'create_account', args: { name: brlName, currency: 'BRL' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: { description: 'Dc usd', amount: 100, date, account: usdName, idempotencyKey: `agg-dc-usd-${stamp}` },
      });
      await callTool(client, {
        name: 'add_account_expense',
        args: { description: 'Dc brl', amount: 500, date, account: brlName, idempotencyKey: `agg-dc-brl-${stamp}` },
      });

      const withoutConversion = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'account', month, year },
      })) as AggResult;
      const withConversion = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'account', month, year, displayCurrency: 'USD' },
      })) as AggResult;

      expect(withConversion.currencies).toEqual(withoutConversion.currencies);
      ensure(withConversion.converted, 'converted block missing when displayCurrency was supplied');
      expect(withConversion.converted).toMatchObject({ displayCurrency: 'USD', stale: false, excluded: [] });
      // Sums every USD/BRL block total across this suite's own runs (shared DB) — assert a floor,
      // not an exact total: 100 + 500*0.2 = 100 from this test's own fixtures alone.
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
      const btcName = `Agg Dc BTC ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: btcName, currency: 'BTC' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: { description: 'Dc btc', amount: 1, date, account: btcName, idempotencyKey: `agg-dc-btc-${stamp}` },
      });

      const result = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'account', month, year, displayCurrency: 'USD' },
      })) as AggResult;
      expect(result.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    } finally {
      await transport.close();
    }
  });

  it('converts the currency block total, not the sum of rows truncated by limit', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const accountName = `Agg Dc Limit ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: accountName, currency: 'USD' } });
      // Two categories in the same USD block; limit:1 below returns only one row, but the block's
      // own `total` (and therefore the converted grand total) must still reflect both.
      await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: 'Dc limit food',
          amount: 100,
          date,
          account: accountName,
          category: 'Food',
          idempotencyKey: `agg-dc-limit-food-${stamp}`,
        },
      });
      await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: 'Dc limit transport',
          amount: 40,
          date,
          account: accountName,
          category: 'Transport',
          idempotencyKey: `agg-dc-limit-transport-${stamp}`,
        },
      });

      const result = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'category', month, year, account: accountName, limit: 1, displayCurrency: 'USD' },
      })) as AggResult;
      const usd = result.currencies.find((c) => c.currency === 'USD')!;
      expect(usd.rows).toHaveLength(1);
      expect(usd.total).toBe(140);
      ensure(result.converted, 'converted block missing when displayCurrency was supplied');
      expect(result.converted.total).toBe(140);
    } finally {
      await transport.close();
    }
  });

  it('metric=count: displayCurrency is a no-op — no converted block even when supplied', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const accountName = `Agg Dc Count ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: accountName, currency: 'USD' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: { description: 'Dc count', amount: 20, date, account: accountName, idempotencyKey: `agg-dc-count-${stamp}` },
      });

      const result = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'category', metric: 'count', month, year, account: accountName, displayCurrency: 'USD' },
      })) as AggResult;
      expect(result).not.toHaveProperty('converted');
    } finally {
      await transport.close();
    }
  });

  it('metric=avg: displayCurrency is a no-op — no converted block even when supplied', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const stamp = Date.now();
      const accountName = `Agg Dc Avg ${stamp}`;
      await callTool(client, { name: 'create_account', args: { name: accountName, currency: 'USD' } });
      await callTool(client, {
        name: 'add_account_expense',
        args: { description: 'Dc avg', amount: 20, date, account: accountName, idempotencyKey: `agg-dc-avg-${stamp}` },
      });

      const result = (await callTool(client, {
        name: 'aggregate_spending',
        args: { groupBy: 'category', metric: 'avg', month, year, account: accountName, displayCurrency: 'USD' },
      })) as AggResult;
      expect(result).not.toHaveProperty('converted');
    } finally {
      await transport.close();
    }
  });

  it('rejects an unknown displayCurrency at the protocol level (not a valid CurrencyCode enum member)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, {
          name: 'aggregate_spending',
          args: { groupBy: 'category', month, year, displayCurrency: 'EUR' },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});
