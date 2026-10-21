import { describe, expect, it } from 'vitest';
import { callTool, makeClient } from './helpers.js';

type Preferences = { locale?: string; localeSource?: string; baseCurrency?: string };

// This suite shares one MCP server/DB across every integration test file (fileParallelism: false),
// and settings is a global singleton row — so, unlike empty-db.test.ts's isolated fresh DB, these
// tests only assert the explicit round-trip (set -> get reflects it), never the "still unset"
// default, which would be order-dependent on whatever another file already stored.
describe('MCP integration > base currency', () => {
  it('set_base_currency sets an explicit override, reflected by get_preferences', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'set_base_currency',
        args: { baseCurrency: 'USDC' },
      })) as { baseCurrency?: string };
      expect(result.baseCurrency).toBe('USDC');

      const prefs = (await callTool(client, { name: 'get_preferences' })) as Preferences;
      expect(prefs.baseCurrency).toBe('USDC');
    } finally {
      await transport.close();
    }
  });

  it('a second set_base_currency overwrites the prior override', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'set_base_currency', args: { baseCurrency: 'BTC' } });
      const result = (await callTool(client, {
        name: 'set_base_currency',
        args: { baseCurrency: 'BRL' },
      })) as { baseCurrency?: string };
      expect(result.baseCurrency).toBe('BRL');

      const prefs = (await callTool(client, { name: 'get_preferences' })) as Preferences;
      expect(prefs.baseCurrency).toBe('BRL');
    } finally {
      await transport.close();
    }
  });

  it('setting the same base currency again is a no-op that still returns it', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'set_base_currency', args: { baseCurrency: 'USD' } });
      const result = (await callTool(client, {
        name: 'set_base_currency',
        args: { baseCurrency: 'USD' },
      })) as { baseCurrency?: string };
      expect(result.baseCurrency).toBe('USD');
    } finally {
      await transport.close();
    }
  });

  it('rejects an invalid currency code at the protocol level (not a valid CurrencyCode enum member)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, { name: 'set_base_currency', args: { baseCurrency: 'NOT_A_CURRENCY' } }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});
