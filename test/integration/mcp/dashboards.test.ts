import { describe, expect, it } from 'vitest';
import { callTool, makeClient } from './helpers.js';

describe('MCP integration > dashboards', () => {
  it('save_dashboard upserts and list_dashboards includes it without the html blob', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const saved = (await callTool(client, {
        name: 'save_dashboard',
        args: { name, html: '<html><body>v1</body></html>' },
      })) as { name?: string; html?: string; updatedAt?: string };
      expect(saved.name).toBe(name);
      expect(saved.html).toBe('<html><body>v1</body></html>');
      expect(saved.updatedAt).toBeTruthy();

      const list = (await callTool(client, { name: 'list_dashboards', args: {} })) as Array<Record<string, unknown>>;
      const entry = list.find((d) => d.name === name);
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty('html');

      const resaved = (await callTool(client, {
        name: 'save_dashboard',
        args: { name, html: '<html><body>v2</body></html>' },
      })) as { html?: string };
      expect(resaved.html).toBe('<html><body>v2</body></html>');
    } finally {
      await transport.close();
    }
  });
});
