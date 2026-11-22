import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, assetPrices, assets, investmentEvents } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { buildApp, type AppContext } from '../app-builder.js';

// The holdings reads answer like the tools they mirror: same input, same output, same errors.
const NOW = new Date('2026-11-21T12:00:00.000Z');

describe('GET /api/portfolio, /api/assets, /api/investment-events', () => {
  let ctx: AppContext;
  let dir: string;
  let client: Client;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patty-holdings-http-'));
    ctx = await buildApp({ dbPath: join(dir, 'test.db') });
    ctx.setClock(() => NOW);
    await ctx.db.insert(accounts).values({
      id: 'acc-broker',
      userId: OWNER_USER_ID,
      name: 'Broker',
      type: 'investment',
      currency: 'USD',
      initialBalance: 100,
    });
    await ctx.db.insert(assets).values([
      {
        id: 'a-nu',
        symbol: 'NU',
        exchange: 'NYSE',
        name: 'Nu',
        assetClass: 'stock',
        currency: 'USD',
        pricing: 'market',
      },
      {
        id: 'a-etf',
        symbol: 'VOO',
        exchange: 'NYSE',
        name: 'Voo',
        assetClass: 'etf',
        currency: 'USD',
        pricing: 'market',
      },
    ]);
    await ctx.db.insert(assetPrices).values({
      id: 'p-nu',
      assetId: 'a-nu',
      price: 12,
      asOf: NOW.toISOString(),
      source: 'test',
    });
    await ctx.db.insert(investmentEvents).values({
      id: 'ev-nu',
      userId: OWNER_USER_ID,
      accountId: 'acc-broker',
      assetId: 'a-nu',
      type: 'opening',
      date: '2026-09-01',
      quantity: 10,
      unitCost: 5,
      idempotencyKey: 'key-ev-nu',
    });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = ctx.app.server.address() as AddressInfo;
    client = new Client({ name: 'holdings-http', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });

  afterAll(async () => {
    await client.close();
    await ctx.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const viaTool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { isError: result.isError === true, payload: JSON.parse(result.content[0]!.text) };
  };
  const viaRoute = async (url: string) => {
    const res = await ctx.app.inject({ method: 'GET', url });
    return { status: res.statusCode, payload: res.json() };
  };

  it('GET /api/portfolio answers what get_portfolio answers', async () => {
    const route = await viaRoute('/api/portfolio');
    expect(route.status).toBe(200);
    expect(route.payload).toEqual((await viaTool('get_portfolio')).payload);
    expect(route.payload.positions[0].asset).toBe('NYSE:NU');
  });

  it('GET /api/portfolio?account= scopes to one account; unknown is a 404 like the tool', async () => {
    expect((await viaRoute('/api/portfolio?account=Broker')).payload).toEqual(
      (await viaTool('get_portfolio', { account: 'Broker' })).payload,
    );
    const route = await viaRoute('/api/portfolio?account=Nope');
    const tool = await viaTool('get_portfolio', { account: 'Nope' });
    expect(route.status).toBe(404);
    expect(tool.isError).toBe(true);
    expect(route.payload.error.code).toBe(tool.payload.error.code);
    expect(route.payload.error.code).toBe('unknown_account');
  });

  it('GET /api/assets answers what list_assets answers, with its filters', async () => {
    expect((await viaRoute('/api/assets')).payload).toEqual((await viaTool('list_assets')).payload);
    const stale = await viaRoute('/api/assets?staleOnly=true');
    expect(stale.payload).toEqual((await viaTool('list_assets', { staleOnly: true })).payload);
    expect(stale.payload.map((asset: { symbol: string }) => asset.symbol)).toEqual(['VOO']);
    const etf = await viaRoute('/api/assets?assetClass=etf');
    expect(etf.payload).toEqual((await viaTool('list_assets', { assetClass: 'etf' })).payload);
  });

  it('GET /api/assets rejects a filter the schema refuses with a 422', async () => {
    expect((await viaRoute('/api/assets?assetClass=crypto')).status).toBe(422);
    expect((await viaRoute('/api/assets?staleOnly=maybe')).status).toBe(422);
  });

  it('GET /api/investment-events answers what list_investment_events answers', async () => {
    expect((await viaRoute('/api/investment-events')).payload).toEqual(
      (await viaTool('list_investment_events')).payload,
    );
    const filtered = await viaRoute('/api/investment-events?account=Broker&asset=NU');
    expect(filtered.payload).toEqual(
      (await viaTool('list_investment_events', { account: 'Broker', asset: 'NU' })).payload,
    );
    expect(filtered.payload[0].id).toBe('ev-nu');
    expect((await viaRoute('/api/investment-events?asset=ZZZ')).status).toBe(404);
  });

  it('answers an ambiguous account or asset with the 409 the OpenAPI document declares', async () => {
    await ctx.db.insert(accounts).values({
      id: 'acc-broker-2',
      userId: OWNER_USER_ID,
      name: 'Broker 2',
      type: 'investment',
      currency: 'USD',
      initialBalance: 0,
    });
    const route = await viaRoute('/api/portfolio?account=Brok');
    const tool = await viaTool('get_portfolio', { account: 'Brok' });
    expect(route.status).toBe(409);
    expect(route.payload.error.code).toBe('ambiguous_account');
    expect(tool.payload.error.code).toBe('ambiguous_account');
    expect((await viaRoute('/api/investment-events?account=Brok')).status).toBe(409);

    const { payload } = await viaRoute('/api/openapi.json');
    expect(payload.paths['/api/portfolio'].get.responses['409']).toBeDefined();
    expect(payload.paths['/api/investment-events'].get.responses['409']).toBeDefined();
  });

  it('documents the three routes in the OpenAPI document', async () => {
    const { payload } = await viaRoute('/api/openapi.json');
    expect(Object.keys(payload.paths)).toEqual(
      expect.arrayContaining(['/api/portfolio', '/api/assets', '/api/investment-events']),
    );
  });
});
