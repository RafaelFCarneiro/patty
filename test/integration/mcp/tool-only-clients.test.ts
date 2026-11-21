import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, callToolError, makeClient, mcpUrl } from './helpers.js';

const WORKFLOW_ARGUMENTS: Record<string, Record<string, string>> = {
  monthly_review: { month: '3', year: '2026' },
  budget_checkup: { month: '11', year: '2025' },
  import_statement: { source: 'account' },
  refresh_quotes: {},
  tour: {},
};

// What a bridge that forwards tools only still gets (Feature Design 024).
describe('MCP integration > tool-only clients', () => {
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

  const textOf = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return result.content[0]!.text;
  };

  it.each(Object.entries(WORKFLOW_ARGUMENTS))(
    'get_workflow %s returns the messages the prompt returns',
    async (name, args) => {
      const prompt = await client.getPrompt({ name, arguments: args });
      const viaTool = await callTool(client, { name: 'get_workflow', args: { name, ...args } });
      expect(viaTool).toEqual({ messages: prompt.messages });
    },
  );

  it('get_workflow without a name lists the prompts the server registers', async () => {
    const list = (await callTool(client, { name: 'get_workflow' })) as Array<{ name: string }>;
    const { prompts } = await client.listPrompts();
    expect(list.map((item) => item.name).sort()).toEqual(prompts.map((prompt) => prompt.name).sort());
  });

  it('get_api_contract lists the routes of the document served at /api/openapi.json', async () => {
    const index = (await textOf('get_api_contract')).split('\n').slice(1);
    const document = (await (await fetch(new URL('/api/openapi.json', new URL(mcpUrl).origin))).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const routes = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path} — `),
    );
    expect(index).toHaveLength(routes.length);
    routes.forEach((route) =>
      expect(
        index.some((line) => line.startsWith(route)),
        route,
      ).toBe(true),
    );
  });

  it('get_api_contract with a path answers that operation of the document', async () => {
    const document = (await (await fetch(new URL('/api/openapi.json', new URL(mcpUrl).origin))).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const [detail] = (await callTool(client, {
      name: 'get_api_contract',
      args: { path: '/api/summary', method: 'get' },
    })) as Array<Record<string, unknown>>;
    expect(detail).toEqual({
      method: 'get',
      path: '/api/summary',
      ...(document.paths['/api/summary']!['get'] as object),
    });
  });

  it('get_api_contract names the close matches of an unknown path', async () => {
    const payload = (await callToolError(client, { name: 'get_api_contract', args: { path: '/api/summaries' } })) as {
      error: { code: string; issues: string[] };
    };
    expect(payload.error.code).toBe('validation');
    expect(payload.error.issues[0]).toContain('/api/summary');
  });

  it('get_dashboard_guide returns the guide, which sends the agent on to get_api_contract', async () => {
    const guide = await textOf('get_dashboard_guide');
    expect(guide).toContain('Hard rules');
    expect(guide).toContain('get_api_contract');
  });

  it('list_currencies and list_top_merchants return what their resources return', async () => {
    const resource = async (uri: string) =>
      JSON.parse(((await client.readResource({ uri })).contents[0] as { text: string }).text);
    expect(await callTool(client, { name: 'list_currencies' })).toEqual(await resource('patty://currencies'));
    expect(await callTool(client, { name: 'list_top_merchants' })).toEqual(await resource('patty://merchants/top'));
  });
});
