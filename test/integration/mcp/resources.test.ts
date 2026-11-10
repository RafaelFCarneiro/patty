import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_TOP_MERCHANTS_LIMIT } from '../../../src/models/merchant.js';
import { callTool, makeClient } from './helpers.js';

type MerchantSummary = { merchant?: string; transactionCount?: number; categoryName?: string | null };

const readResourceJson = async (client: Client, uri: string): Promise<unknown> => {
  const { contents } = await client.readResource({ uri });
  expect(contents).toHaveLength(1);
  expect(contents[0]?.mimeType).toBe('application/json');
  return JSON.parse((contents[0] as { text: string }).text);
};

describe('MCP reference resources (Feature Design 018)', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);
  });

  afterAll(async () => {
    await transport.close();
  });

  it('lists all reference resources plus openapi', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining([
        'patty://openapi',
        'patty://categories',
        'patty://accounts',
        'patty://currencies',
        'patty://exchange-rates',
        'patty://tags',
        'patty://credit-cards',
        'patty://merchants/top',
      ]),
    );
  });

  it('patty://categories returns the same data as list_categories', async () => {
    const [resource, tool] = await Promise.all([
      readResourceJson(client, 'patty://categories'),
      callTool(client, { name: 'list_categories' }),
    ]);
    expect(resource).toEqual(tool);
  });

  it('patty://accounts returns the same data as list_accounts', async () => {
    const [resource, tool] = await Promise.all([
      readResourceJson(client, 'patty://accounts'),
      callTool(client, { name: 'list_accounts' }),
    ]);
    expect(resource).toEqual(tool);
  });

  it('patty://currencies returns fiat and crypto with symbol/decimals (ADR-026)', async () => {
    const currencies = (await readResourceJson(client, 'patty://currencies')) as Array<{
      code: string;
      symbol: string;
      decimals: number;
    }>;
    const byCode = Object.fromEntries(currencies.map((c) => [c.code, c]));
    expect(byCode.MXN).toMatchObject({ symbol: 'MX$', decimals: 2 });
    expect(byCode.COP).toMatchObject({ symbol: 'COL$', decimals: 2 });
    expect(byCode.BTC).toMatchObject({ symbol: '₿', decimals: 8 });
    expect(byCode.USDC).toMatchObject({ decimals: 6 });
  });

  it('patty://exchange-rates returns the same data as list_exchange_rates (ADR-026)', async () => {
    await callTool(client, {
      name: 'set_exchange_rate',
      args: { from: 'USD', to: 'BRL', rate: 5.2, asOf: '2026-08-10T10:00:00.000Z' },
    });
    const [resource, tool] = await Promise.all([
      readResourceJson(client, 'patty://exchange-rates'),
      callTool(client, { name: 'list_exchange_rates' }),
    ]);
    expect(resource).toEqual(tool);
  });

  it('patty://tags returns the same data as list_tags', async () => {
    const [resource, tool] = await Promise.all([
      readResourceJson(client, 'patty://tags'),
      callTool(client, { name: 'list_tags' }),
    ]);
    expect(resource).toEqual(tool);
  });

  it('patty://credit-cards returns the same data as list_credit_cards', async () => {
    const [resource, tool] = await Promise.all([
      readResourceJson(client, 'patty://credit-cards'),
      callTool(client, { name: 'list_credit_cards' }),
    ]);
    expect(resource).toEqual(tool);
  });

  it('patty://merchants/top returns at most 20 merchants, ordered by transactionCount descending', async () => {
    const merchants = (await readResourceJson(client, 'patty://merchants/top')) as MerchantSummary[];
    expect(Array.isArray(merchants)).toBe(true);
    expect(merchants.length).toBeLessThanOrEqual(DEFAULT_TOP_MERCHANTS_LIMIT);
    for (const entry of merchants) {
      expect(typeof entry.merchant).toBe('string');
      expect(typeof entry.transactionCount).toBe('number');
      expect(entry.categoryName === null || typeof entry.categoryName === 'string').toBe(true);
    }
    for (let i = 1; i < merchants.length; i += 1) {
      expect(merchants[i - 1]!.transactionCount!).toBeGreaterThanOrEqual(merchants[i]!.transactionCount!);
    }
  });
});
