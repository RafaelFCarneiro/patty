import { describe, expect, it } from 'vitest';
import { callTool, callToolError, makeClient } from './helpers.js';

type RateView = { from?: string; to?: string; rate?: number; asOf?: string; source?: string };
type BulkItem = { status?: string; from?: string; to?: string; rate?: RateView; error?: string };
type BulkResult = { items?: BulkItem[] };

describe('MCP integration > exchange rates', () => {
  it('set_exchange_rate upserts a new pair and returns the view', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const rate = (await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'USD', to: 'BRL', rate: 5.18, asOf: '2026-08-10T10:00:00.000Z', source: 'PTAX' },
      })) as RateView;
      expect(rate).toEqual({ from: 'USD', to: 'BRL', rate: 5.18, asOf: '2026-08-10T10:00:00.000Z', source: 'PTAX' });
    } finally {
      await transport.close();
    }
  });

  it('set_exchange_rate rejects from === to', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const error = (await callToolError(client, {
        name: 'set_exchange_rate',
        args: { from: 'BTC', to: 'BTC', rate: 1, asOf: '2026-08-10T10:00:00.000Z' },
      })) as { error?: { code?: string } };
      expect(error.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('upsert-latest: a second call for the same pair overwrites, list_exchange_rates shows one row', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'USD', to: 'USDC', rate: 1, asOf: '2026-08-10T08:00:00.000Z' },
      });
      const updated = (await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'USD', to: 'USDC', rate: 1.002, asOf: '2026-08-10T09:00:00.000Z' },
      })) as RateView;
      expect(updated).toMatchObject({ rate: 1.002, asOf: '2026-08-10T09:00:00.000Z' });

      const rates = (await callTool(client, { name: 'list_exchange_rates', args: {} })) as RateView[];
      const matching = rates.filter((r) => r.from === 'USD' && r.to === 'USDC');
      expect(matching).toHaveLength(1);
      expect(matching[0]?.rate).toBe(1.002);
    } finally {
      await transport.close();
    }
  });

  it('is race-safe: concurrent calls for the same new pair both succeed, exactly one row survives', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const results = await Promise.allSettled([
        callTool(client, {
          name: 'set_exchange_rate',
          args: { from: 'BTC', to: 'BRL', rate: 300000, asOf: '2026-08-10T10:00:00.000Z' },
        }),
        callTool(client, {
          name: 'set_exchange_rate',
          args: { from: 'BTC', to: 'BRL', rate: 300001, asOf: '2026-08-10T10:00:01.000Z' },
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);

      const rates = (await callTool(client, { name: 'list_exchange_rates', args: {} })) as RateView[];
      expect(rates.filter((r) => r.from === 'BTC' && r.to === 'BRL')).toHaveLength(1);
    } finally {
      await transport.close();
    }
  });

  it('set_exchange_rates (bulk) reports partial success — one bad pair does not block the others', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'set_exchange_rates',
        args: {
          rates: [
            { from: 'USD', to: 'BRL', rate: 5.2, asOf: '2026-08-10T10:00:00.000Z' },
            { from: 'USDC', to: 'USDC', rate: 1, asOf: '2026-08-10T10:00:00.000Z' },
          ],
        },
      })) as BulkResult;

      expect(result.items).toHaveLength(2);
      expect(result.items?.[0]).toMatchObject({ status: 'ok' });
      expect(result.items?.[1]).toMatchObject({ status: 'error', from: 'USDC', to: 'USDC' });
    } finally {
      await transport.close();
    }
  });

  it('list_exchange_rates returns [] when nothing matches (fresh pair never set)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const rates = (await callTool(client, { name: 'list_exchange_rates', args: {} })) as RateView[];
      expect(rates.some((r) => r.from === 'BTC' && r.to === 'USDC')).toBe(false);
    } finally {
      await transport.close();
    }
  });
});
