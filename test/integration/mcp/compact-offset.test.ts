import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerGate } from '../../../src/diplomat/mcp/gate.js';
import { buildMcpServer } from '../../../src/diplomat/mcp/server.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { connectInProcess } from '../mcp-in-process.js';
import { callTool } from './helpers.js';

type RateView = { from?: string; to?: string; asOf?: string };

let tmpDir: string;
let ctx: AppContext;
let client: Client;
let close: () => Promise<void>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-compact-offset-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  await ctx.app.ready();
  ({ client, close } = await connectInProcess(buildMcpServer(ctx.runtime, ctx.version, { gate: ownerGate })));
});

afterAll(async () => {
  await close();
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('MCP integration > compact timestamp offsets', () => {
  it('a "-03" asOf is listed as UTC and the rate goes stale once past the window', async () => {
    const accountName = 'Compact offset';
    await callTool(client, { name: 'set_base_currency', args: { baseCurrency: 'USD' } });
    await callTool(client, {
      name: 'create_account',
      args: { name: accountName, type: 'checking', currency: 'MXN', initialBalance: 100 },
    });
    await callTool(client, {
      name: 'set_exchange_rate',
      args: { from: 'MXN', to: 'USD', rate: 0.05, asOf: '2020-01-01T00:00:00-03' },
    });

    const rates = (await callTool(client, { name: 'list_exchange_rates', args: {} })) as RateView[];
    expect(rates.find((r) => r.from === 'MXN' && r.to === 'USD')?.asOf).toBe('2020-01-01T03:00:00.000Z');

    const result = (await callTool(client, { name: 'get_account_balances', args: { account: accountName } })) as {
      balances: Array<{ name?: string; converted?: { asOf: string; stale: boolean } }>;
    };
    expect(result.balances.find((b) => b.name === accountName)?.converted).toMatchObject({
      asOf: '2020-01-01T03:00:00.000Z',
      stale: true,
    });
  });
});
