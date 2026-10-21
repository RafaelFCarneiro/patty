import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Tenancy } from '../../../../src/controllers/deps.js';
import { ownerGate } from '../../../../src/diplomat/mcp/gate.js';
import { buildMcpServer } from '../../../../src/diplomat/mcp/server.js';

const listSurface = async () => {
  const server = buildMcpServer({} as Tenancy, '0.0.0-test', { gate: ownerGate });
  const client = new Client({ name: 'surface-contract', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const surface = {
    tools: (await client.listTools()).tools,
    resources: (await client.listResources()).resources,
    resourceTemplates: (await client.listResourceTemplates()).resourceTemplates,
    prompts: (await client.listPrompts()).prompts,
  };
  await client.close();
  return surface;
};

// Freezes the MCP contract: any diff here is a behavior change, not a refactor.
describe('MCP surface contract', () => {
  it('lists exactly the committed tools, resources, templates and prompts', async () => {
    await expect(JSON.stringify(await listSurface(), null, 2)).toMatchFileSnapshot('__snapshots__/surface.json');
  });
});
