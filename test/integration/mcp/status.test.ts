import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, makeClient } from './helpers.js';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { version: string };

type Status = { name: string; version: string; db: string; locale: string };

describe('MCP integration > get_status', () => {
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

  it('returns name, version, db ok, and locale', async () => {
    const status = (await callTool(client, { name: 'get_status' })) as Status;
    expect(status.name).toBe('fintrack');
    expect(status.version).toBe(pkg.version);
    expect(status.version.length).toBeGreaterThan(0);
    expect(status.db).toBe('ok');
    expect(status.locale).toBe('en');
  });

  it('reflects locale change after set_locale', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } });
    const status = (await callTool(client, { name: 'get_status' })) as Status;
    expect(status.locale).toBe('pt');

    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
  });
});
