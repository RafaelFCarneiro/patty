import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeClient, mcpUrl } from './helpers.js';

describe('MCP resource > fintrack://openapi', () => {
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

  it('is listed among available resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('fintrack://openapi');
  });

  it('returns the same OpenAPI document served at GET /api/openapi.json', async () => {
    const { contents } = await client.readResource({ uri: 'fintrack://openapi' });
    expect(contents).toHaveLength(1);
    expect(contents[0]?.mimeType).toBe('application/json');

    const doc = JSON.parse(contents[0]?.text as string) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);

    const httpRes = await fetch(new URL('/api/openapi.json', new URL(mcpUrl).origin));
    const httpDoc = await httpRes.json();
    expect(doc).toEqual(httpDoc);
  });
});
