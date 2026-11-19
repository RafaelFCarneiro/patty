import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, callToolError, makeClient, searchTransactions } from './helpers.js';

type Balances = {
  balances: Array<{
    name: string;
    balance: number;
    holdings?: {
      cashBalance: number;
      holdingsValue: number;
      total: number | null;
      stale: boolean;
      excluded: Array<{ asset: string; reason: string }>;
    };
  }>;
  consolidatedNetWorth: {
    baseCurrency: string;
    total: number;
    excluded: string[];
    holdings?: { value: number; excluded: Array<{ asset: string; reason: string }> };
  };
};
type Portfolio = {
  baseCurrency: string;
  positions: Array<{
    asset: string;
    quantity: number;
    avgCost: number;
    price: number | null;
    marketValue: number | null;
    unrealized: number | null;
    noPrice: boolean;
    noRate: boolean;
    base: { marketValue: number | null; rate: number } | null;
  }>;
  totals: {
    marketValue: number;
    costBasis: number;
    unrealized: number;
    excluded: Array<{ asset: string; reason: string }>;
  };
  allocation: { byAssetClass: Array<{ key: string; pct: number }>; byCurrency: Array<{ key: string; pct: number }> };
};
type AssetRow = { symbol: string; price: number | null; stale: boolean; noPrice: boolean; priceAsOf: string | null };

const ASOF = '2026-11-18T21:00:00.000Z';

describe('MCP integration > investment holdings (ADR-038 step 1)', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    await callTool(client, { name: 'set_base_currency', args: { baseCurrency: 'USD' } });
  });

  afterAll(async () => {
    await transport.close();
  });

  const tool = (name: string, args: Record<string, unknown> = {}) => callTool(client, { name, args });
  const toolError = (name: string, args: Record<string, unknown> = {}) => callToolError(client, { name, args });
  const errorCode = (payload: unknown): string => (payload as { error: { code: string } }).error.code;
  const balancesOf = async (account?: string) =>
    (await tool('get_account_balances', account ? { account } : {})) as Balances;

  const registerNu = (symbol: string, extra: Record<string, unknown> = {}) =>
    tool('register_asset', {
      symbol,
      exchange: 'NYSE',
      name: `${symbol} Holdings`,
      assetClass: 'stock',
      currency: 'USD',
      pricing: 'market',
      ...extra,
    });

  it('converts a static account into a holding: cash and holdings side by side, in the net worth', async () => {
    await tool('create_account', { name: 'Brokerage A', type: 'investment', currency: 'USD', initialBalance: 5000 });
    await registerNu('AAA');
    await tool('set_asset_prices', { prices: [{ asset: 'AAA', price: 13.2, asOf: ASOF, source: 'NYSE close' }] });
    const transactionsBefore = await searchTransactions(client, {});
    const before = await balancesOf('Brokerage A');
    expect(before.balances[0]).toMatchObject({ balance: 5000 });
    expect(before.balances[0]!.holdings).toBeUndefined();
    expect(before.consolidatedNetWorth.holdings).toBeUndefined();

    const opened = (await tool('open_position', {
      account: 'Brokerage A',
      asset: 'AAA',
      quantity: 120,
      avgCost: 9.4,
      remainingCash: 85,
      date: '2026-11-01',
    })) as { id: string; costBasis: number; warnings: string[]; asset: string };
    expect(opened).toMatchObject({ asset: 'NYSE:AAA', costBasis: 1128, warnings: [] });

    const after = await balancesOf('Brokerage A');
    expect(after.balances[0]).toMatchObject({
      balance: 85,
      holdings: { cashBalance: 85, holdingsValue: 1584, total: 1669, stale: false, excluded: [] },
    });
    expect(after.consolidatedNetWorth).toMatchObject({ baseCurrency: 'USD', total: 1669, holdings: { value: 1584 } });

    const portfolio = (await tool('get_portfolio', { account: 'Brokerage A' })) as Portfolio;
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0]).toMatchObject({
      asset: 'NYSE:AAA',
      quantity: 120,
      avgCost: 9.4,
      price: 13.2,
      marketValue: 1584,
      unrealized: 456,
      base: { marketValue: 1584, rate: 1 },
    });
    expect(portfolio.totals).toMatchObject({ marketValue: 1584, costBasis: 1128, unrealized: 456, excluded: [] });
    expect(portfolio.allocation.byAssetClass).toEqual([{ key: 'stock', value: 1584, pct: 100 }]);

    // Mark-to-market never writes a transaction: a new price moves the portfolio, not the ledger.
    await tool('set_asset_prices', { prices: [{ asset: 'AAA', price: 15, asOf: '2026-11-19T21:00:00.000Z' }] });
    expect(((await tool('get_portfolio', {})) as Portfolio).positions[0]?.marketValue).toBe(1800);
    expect(await searchTransactions(client, {})).toEqual(transactionsBefore);
  });

  it('an account without positions answers exactly as before — no holdings key at all', async () => {
    await tool('create_account', { name: 'Plain Checking', type: 'checking', currency: 'USD', initialBalance: 40 });
    const result = (await tool('get_account_balances', { account: 'Plain Checking' })) as Balances;
    expect(Object.keys(result.balances[0]!)).not.toContain('holdings');
    expect(Object.keys(result.consolidatedNetWorth).sort()).toEqual(['baseCurrency', 'excluded', 'total']);
  });

  it('refuses an opening on a non-investment account, an unknown asset or with no cost, writing nothing', async () => {
    await tool('create_account', { name: 'Brokerage B', type: 'investment', currency: 'USD', initialBalance: 700 });
    await registerNu('BBB');
    const eventsBefore = ((await tool('list_investment_events', {})) as unknown[]).length;

    expect(
      errorCode(await toolError('open_position', { account: 'Plain Checking', asset: 'BBB', quantity: 1, avgCost: 1 })),
    ).toBe('validation');
    expect(
      errorCode(await toolError('open_position', { account: 'Brokerage B', asset: 'NOPE', quantity: 1, avgCost: 1 })),
    ).toBe('unknown_asset');
    expect(
      errorCode(await toolError('open_position', { account: 'Nowhere', asset: 'BBB', quantity: 1, avgCost: 1 })),
    ).toBe('unknown_account');
    const noCost = JSON.stringify(
      await toolError('open_position', { account: 'Brokerage B', asset: 'BBB', quantity: 1 }),
    );
    expect(noCost).toContain('set a price or give avgCost');
    await expect(
      callTool(client, {
        name: 'open_position',
        args: { account: 'Brokerage B', asset: 'BBB', quantity: 0, avgCost: 1 },
      }),
    ).rejects.toThrow();

    expect(((await tool('list_investment_events', {})) as unknown[]).length).toBe(eventsBefore);
    expect((await balancesOf('Brokerage B')).balances[0]).toMatchObject({ balance: 700 });
  });

  it('defaults the average cost to the latest price with a warning, and refuses a second opening', async () => {
    await tool('create_account', { name: 'Brokerage C', type: 'investment', currency: 'USD', initialBalance: 10 });
    await registerNu('CCC');
    await tool('set_asset_prices', { prices: [{ asset: 'CCC', price: 20, asOf: ASOF }] });
    const opened = (await tool('open_position', { account: 'Brokerage C', asset: 'CCC', quantity: 2 })) as {
      avgCost: number;
      warnings: string[];
    };
    expect(opened.avgCost).toBe(20);
    expect(opened.warnings).toHaveLength(1);
    expect(opened.warnings[0]).toContain('P&L for NYSE:CCC starts at the latest price');
    expect((await balancesOf('Brokerage C')).balances[0]).toMatchObject({ balance: 0 });

    expect(
      errorCode(await toolError('open_position', { account: 'Brokerage C', asset: 'CCC', quantity: 3, avgCost: 1 })),
    ).toBe('validation');
  });

  it('keeps an asset without a price out of the totals, named — never counted as zero', async () => {
    await tool('create_account', { name: 'Brokerage D', type: 'investment', currency: 'USD', initialBalance: 0 });
    await registerNu('DDD');
    await tool('open_position', { account: 'Brokerage D', asset: 'DDD', quantity: 5, avgCost: 10 });
    const portfolio = (await tool('get_portfolio', { account: 'Brokerage D' })) as Portfolio;
    expect(portfolio.positions[0]).toMatchObject({ noPrice: true, marketValue: null, unrealized: null });
    expect(portfolio.totals).toMatchObject({ marketValue: 0, excluded: [{ asset: 'NYSE:DDD', reason: 'no_price' }] });
    const balances = await balancesOf('Brokerage D');
    expect(balances.consolidatedNetWorth.holdings?.excluded).toEqual([
      { account: 'Brokerage D', asset: 'NYSE:DDD', reason: 'no_price' },
    ]);
  });

  it('values a manual asset in another currency from its posted price and the stored rate', async () => {
    await tool('create_account', { name: 'Itaú Renda Fixa', type: 'investment', currency: 'BRL', initialBalance: 0 });
    await tool('register_asset', {
      symbol: 'CDB-X',
      exchange: 'ITAU',
      name: 'CDB Itaú X',
      assetClass: 'fixed_income',
      currency: 'BRL',
      pricing: 'manual',
    });
    await tool('set_asset_prices', { prices: [{ asset: 'CDB-X', price: 10_500, asOf: ASOF, source: 'app do banco' }] });
    await tool('open_position', { account: 'Itaú Renda Fixa', asset: 'CDB-X', quantity: 1, avgCost: 10_000 });

    await tool('set_exchange_rate', { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() });
    const withRate = (await tool('get_portfolio', { account: 'Itaú Renda Fixa' })) as Portfolio;
    expect(withRate.positions[0]).toMatchObject({
      noRate: false,
      unrealized: 500,
      base: { marketValue: 2100, rate: 0.2 },
    });
    expect(withRate.totals).toMatchObject({ marketValue: 2100, costBasis: 2000, unrealized: 100, excluded: [] });
  });

  it('refuses to delete an account, or change its type, while it has investment events', async () => {
    await tool('create_account', { name: 'Brokerage F', type: 'investment', currency: 'USD', initialBalance: 0 });
    await registerNu('FFF');
    await tool('open_position', { account: 'Brokerage F', asset: 'FFF', quantity: 1, avgCost: 1 });
    const inUse = (await toolError('delete_account', { name: 'Brokerage F' })) as {
      error: { code: string; references: { investmentEvents: number } };
    };
    expect(inUse.error).toMatchObject({ code: 'in_use', references: { investmentEvents: 1 } });
    expect(errorCode(await toolError('update_account', { name: 'Brokerage F', type: 'savings' }))).toBe('validation');
    expect(errorCode(await toolError('update_account', { name: 'Brokerage F', currency: 'BRL' }))).toBe('validation');
    expect(await tool('update_account', { name: 'Brokerage F', newName: 'Brokerage F2' })).toMatchObject({
      type: 'investment',
    });
  });

  it('lists, updates and deletes events; a deleted opening drops the position and gives the cash back', async () => {
    await tool('create_account', { name: 'Brokerage E', type: 'investment', currency: 'USD', initialBalance: 0 });
    await registerNu('EEE');
    await tool('set_asset_prices', { prices: [{ asset: 'EEE', price: 10, asOf: ASOF }] });
    const opened = (await tool('open_position', {
      account: 'Brokerage E',
      asset: 'EEE',
      quantity: 4,
      avgCost: 5,
      remainingCash: 30,
    })) as { id: string };

    const events = (await tool('list_investment_events', { account: 'Brokerage E' })) as Array<{
      id: string;
      type: string;
      quantity: number;
    }>;
    expect(events).toEqual([expect.objectContaining({ id: opened.id, type: 'opening', quantity: 4 })]);

    const updated = (await tool('update_investment_event', { id: opened.id, quantity: 6, note: 'corrected' })) as {
      quantity: number;
      note: string;
    };
    expect(updated).toMatchObject({ quantity: 6, note: 'corrected' });
    expect(((await tool('get_portfolio', { account: 'Brokerage E' })) as Portfolio).positions[0]).toMatchObject({
      quantity: 6,
      marketValue: 60,
    });

    expect(await tool('delete_investment_event', { id: opened.id })).toEqual({
      deleted: true,
      restoredCash: { account: 'Brokerage E', initialBalance: 0 },
    });
    expect(await tool('delete_investment_event', { id: opened.id })).toEqual({ deleted: false });
    expect(((await tool('get_portfolio', { account: 'Brokerage E' })) as Portfolio).positions).toEqual([]);
    expect((await balancesOf('Brokerage E')).balances[0]).toMatchObject({ balance: 0 });
    expect(errorCode(await toolError('update_investment_event', { id: opened.id, quantity: 1 }))).toBe(
      'unknown_investment_event',
    );
  });

  it('keeps a price history: newest instant is latest, a repeat revises it, a bad item fails alone', async () => {
    await registerNu('HHH');
    const result = (await tool('set_asset_prices', {
      prices: [
        { asset: 'HHH', price: 1, asOf: '2026-11-10T21:00:00.000Z' },
        { asset: 'HHH', price: 2, asOf: '2026-11-12T21:00:00.000Z' },
        { asset: 'ZZZ-NONE', price: 3, asOf: '2026-11-12T21:00:00.000Z' },
      ],
    })) as { items: Array<{ status: string; asset?: string; error?: string }> };
    expect(result.items.map((i) => i.status)).toEqual(['ok', 'ok', 'error']);
    expect(result.items[2]).toMatchObject({ asset: 'ZZZ-NONE' });
    expect(result.items[2]!.error).toContain('unknown_asset');

    const latest = async () => ((await tool('list_assets', {})) as AssetRow[]).find((asset) => asset.symbol === 'HHH');
    expect(await latest()).toMatchObject({ price: 2, priceAsOf: '2026-11-12T21:00:00.000Z', noPrice: false });

    await tool('set_asset_prices', { prices: [{ asset: 'HHH', price: 2.5, asOf: '2026-11-12T21:00:00.000Z' }] });
    expect(await latest()).toMatchObject({ price: 2.5 });
    await tool('set_asset_prices', { prices: [{ asset: 'HHH', price: 9, asOf: '2026-11-11T21:00:00.000Z' }] });
    expect(await latest()).toMatchObject({ price: 2.5 });
  });

  it('registers idempotently, lists stale and unpriced assets with staleOnly, and mirrors it in patty://assets', async () => {
    const first = (await registerNu('GGG')) as { created: boolean; asset: { id: string } };
    const again = (await registerNu('ggg', { name: 'GGG Renamed' })) as {
      created: boolean;
      asset: { id: string; name: string };
    };
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, asset: { id: first.asset.id, name: 'GGG Renamed' } });
    const warned = (await registerNu('GGG', { name: 'GGG Renamed', assetClass: 'etf' })) as { warnings?: string[] };
    expect(warned.warnings?.[0]).toContain('assetClass stays stock');

    const stale = (await tool('list_assets', { staleOnly: true })) as AssetRow[];
    expect(stale.map((a) => a.symbol)).toContain('GGG');
    const { contents } = await client.readResource({ uri: 'patty://assets' });
    const listed = JSON.parse((contents[0] as { text: string }).text) as AssetRow[];
    expect(listed.map((a) => a.symbol)).toEqual(expect.arrayContaining(['AAA', 'GGG', 'CDB-X']));
  });

  it('is reversible: deleting an opening gives back the cash it replaced, in the same write', async () => {
    await tool('create_account', { name: 'Brokerage R', type: 'investment', currency: 'USD', initialBalance: 700 });
    await registerNu('RRR');
    const opened = (await tool('open_position', {
      account: 'Brokerage R',
      asset: 'RRR',
      quantity: 2,
      avgCost: 3,
      remainingCash: 85,
    })) as { id: string };
    expect((await balancesOf('Brokerage R')).balances[0]).toMatchObject({ balance: 85 });

    expect(await tool('delete_investment_event', { id: opened.id })).toEqual({
      deleted: true,
      restoredCash: { account: 'Brokerage R', initialBalance: 700 },
    });
    const after = await balancesOf('Brokerage R');
    expect(after.balances[0]).toMatchObject({ balance: 700 });
    expect(after.balances[0]!.holdings).toBeUndefined();
  });

  describe('remainingCash is the balance after: existing activity is offset, not double-counted', () => {
    const asset = async (symbol: string) => {
      await registerNu(symbol);
      await tool('set_asset_prices', { prices: [{ asset: symbol, price: 10, asOf: ASOF }] });
    };
    const open = (account: string, symbol: string, remainingCash: number) =>
      tool('open_position', { account, asset: symbol, quantity: 100, avgCost: 9, remainingCash }) as Promise<{
        id: string;
        warnings: string[];
        existingActivity: { transactions: number; net: number };
      }>;

    it('a funded account: +1000 transferred in, remainingCash 0 → cash 0, net worth is the holdings only', async () => {
      await tool('create_account', { name: 'Checking F', type: 'checking', currency: 'USD', initialBalance: 5000 });
      await tool('create_account', { name: 'Brokerage F', type: 'investment', currency: 'USD', initialBalance: 0 });
      await tool('create_transfer', { from: 'Checking F', to: 'Brokerage F', amount: 1000, description: 'fund' });
      await asset('FFF');
      expect((await balancesOf('Brokerage F')).balances[0]).toMatchObject({ balance: 1000 });

      const opened = await open('Brokerage F', 'FFF', 0);
      expect(opened.existingActivity).toEqual({ transactions: 1, net: 1000 });
      expect(opened.warnings).toHaveLength(1);

      expect((await balancesOf('Brokerage F')).balances[0]).toMatchObject({
        balance: 0,
        holdings: { cashBalance: 0, holdingsValue: 1000, total: 1000 },
      });

      await tool('delete_investment_event', { id: opened.id });
      const restored = (await balancesOf('Brokerage F')).balances[0];
      expect(restored).toMatchObject({ balance: 1000 });
      expect(restored!.holdings).toBeUndefined();
    });

    it('income and expenses that recorded market moves are offset the same way, and restored', async () => {
      await tool('create_account', { name: 'Brokerage M', type: 'investment', currency: 'USD', initialBalance: 200 });
      await tool('add_account_income', { account: 'Brokerage M', amount: 300, description: 'Rendimentos' });
      await tool('add_account_expense', { account: 'Brokerage M', amount: 50, description: 'Ajuste' });
      await asset('MMM');
      expect((await balancesOf('Brokerage M')).balances[0]).toMatchObject({ balance: 450 });

      const opened = await open('Brokerage M', 'MMM', 85);
      expect(opened.existingActivity).toEqual({ transactions: 2, net: 250 });
      expect((await balancesOf('Brokerage M')).balances[0]).toMatchObject({ balance: 85 });

      await tool('delete_investment_event', { id: opened.id });
      expect((await balancesOf('Brokerage M')).balances[0]).toMatchObject({ balance: 450 });
    });

    it('counts only effective transactions: a pending one reports nothing and does not warn', async () => {
      await tool('create_account', { name: 'Brokerage P', type: 'investment', currency: 'USD', initialBalance: 90 });
      await tool('add_account_income', {
        account: 'Brokerage P',
        amount: 500,
        description: 'Expected',
        status: 'pending',
      });
      await asset('PPP');
      const opened = await open('Brokerage P', 'PPP', 40);
      expect(opened).toMatchObject({ warnings: [], existingActivity: { transactions: 0, net: 0 } });
      expect((await balancesOf('Brokerage P')).balances[0]).toMatchObject({ balance: 40 });
    });

    it('an account without activity answers as before: no warning, an empty activity', async () => {
      await tool('create_account', { name: 'Brokerage Q', type: 'investment', currency: 'USD', initialBalance: 90 });
      await asset('QQQ');
      const opened = await open('Brokerage Q', 'QQQ', 40);
      expect(opened).toMatchObject({ warnings: [], existingActivity: { transactions: 0, net: 0 } });
      expect((await balancesOf('Brokerage Q')).balances[0]).toMatchObject({ balance: 40 });
    });
  });

  describe('the cash from before the holdings comes back with the account’s last event (ADR-038 §7)', () => {
    const openOn = (account: string, asset: string, remainingCash: number) =>
      tool('open_position', { account, asset, quantity: 1, avgCost: 1, remainingCash }) as Promise<{ id: string }>;

    it('A (700→85) and B (85→85): deleting A restores nothing, B stays valued; deleting B restores 700', async () => {
      await tool('create_account', { name: 'Brokerage U', type: 'investment', currency: 'USD', initialBalance: 700 });
      await registerNu('UUA');
      await registerNu('UUB');
      await tool('set_asset_prices', {
        prices: [
          { asset: 'UUA', price: 10, asOf: ASOF },
          { asset: 'UUB', price: 20, asOf: ASOF },
        ],
      });
      const first = await openOn('Brokerage U', 'UUA', 85);
      const second = await openOn('Brokerage U', 'UUB', 85);

      expect(await tool('delete_investment_event', { id: first.id })).toEqual({ deleted: true });
      const midway = await balancesOf('Brokerage U');
      expect(midway.balances[0]).toMatchObject({ balance: 85, holdings: { holdingsValue: 20 } });

      expect(await tool('delete_investment_event', { id: second.id })).toEqual({
        deleted: true,
        restoredCash: { account: 'Brokerage U', initialBalance: 700 },
      });
      expect((await balancesOf('Brokerage U')).balances[0]).toMatchObject({ balance: 700 });
    });

    it.each([
      ['first then second', [0, 1]],
      ['second then first', [1, 0]],
    ])('A (700→85) and B (85→0), deleted %s: no deadlock, the last restores the 700', async (_order, order) => {
      const suffix = order[0] === 0 ? 'X' : 'Y';
      const name = `Brokerage V${suffix}`;
      await tool('create_account', { name, type: 'investment', currency: 'USD', initialBalance: 700 });
      await registerNu(`VVA${suffix}`);
      await registerNu(`VVB${suffix}`);
      const opened = [await openOn(name, `VVA${suffix}`, 85), await openOn(name, `VVB${suffix}`, 0)];

      expect(await tool('delete_investment_event', { id: opened[order[0]!]!.id })).toEqual({ deleted: true });
      expect(await tool('delete_investment_event', { id: opened[order[1]!]!.id })).toEqual({
        deleted: true,
        restoredCash: { account: name, initialBalance: 700 },
      });
      expect((await balancesOf(name)).balances[0]).toMatchObject({ balance: 700 });
    });
  });

  it('an opening that replaced nothing restores nothing when deleted', async () => {
    await tool('create_account', { name: 'Brokerage S', type: 'investment', currency: 'USD', initialBalance: 40 });
    await registerNu('SSS');
    const opened = (await tool('open_position', {
      account: 'Brokerage S',
      asset: 'SSS',
      quantity: 1,
      avgCost: 3,
      remainingCash: 40,
    })) as { id: string };
    await tool('update_account', { name: 'Brokerage S', initialBalance: 55 });

    expect(await tool('delete_investment_event', { id: opened.id })).toEqual({ deleted: true });
    expect((await balancesOf('Brokerage S')).balances[0]).toMatchObject({ balance: 55 });
  });

  it('lets exactly one of two concurrent openings of a position win; the other gets the ordinary error', async () => {
    await tool('create_account', { name: 'Brokerage T', type: 'investment', currency: 'USD', initialBalance: 0 });
    await registerNu('TTT');
    const open = (quantity: number) =>
      callTool(client, {
        name: 'open_position',
        args: { account: 'Brokerage T', asset: 'TTT', quantity, avgCost: 1 },
      });

    const settled = await Promise.allSettled([open(1), open(2)]);
    const won = settled.filter((outcome) => outcome.status === 'fulfilled');
    const lost = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0]!.reason)).toContain('already has an opening for NYSE:TTT');
    expect(((await tool('list_investment_events', { account: 'Brokerage T' })) as unknown[]).length).toBe(1);
  });

  it.each(['symbol', 'exchange', 'name'])('refuses a whitespace-only %s and stores nothing', async (field) => {
    const before = (await tool('list_assets', {})) as AssetRow[];
    await expect(
      callTool(client, {
        name: 'register_asset',
        args: {
          symbol: 'BLANKX',
          exchange: 'NYSE',
          name: 'Blank Test',
          assetClass: 'stock',
          currency: 'USD',
          pricing: 'market',
          [field]: '   ',
        },
      }),
    ).rejects.toThrow();
    expect(await tool('list_assets', {})).toEqual(before);
  });

  it('serves the refresh_quotes prompt', async () => {
    const result = await client.getPrompt({ name: 'refresh_quotes' });
    const text = (result.messages[0]!.content as { text: string }).text;
    expect(text).toContain('get_portfolio');
    expect(text).toContain('set_asset_prices');
  });
});
