import { describe, expect, it } from 'vitest';
import { callTool, callToolError, makeClient, mcpUrl } from './helpers.js';

type ValidationErrorPayload = { error: { code: string; issues: string[] } };

// MCP has no get_dashboard tool to re-read stored HTML by name — REST does (GET
// /api/dashboards/:name), and the same Fastify instance backs both surfaces in this test harness
// (test/integration/mcp/setup.ts), so this is the only way to actually assert the stored content,
// not just that the name still appears in list_dashboards (which omits html).
const fetchStoredHtml = async (name: string): Promise<string> => {
  const res = await fetch(new URL(`/api/dashboards/${name}`, new URL(mcpUrl).origin));
  const body = (await res.json()) as { html: string };
  return body.html;
};

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

  it('save_dashboard rejects html with no <html> root and leaves the prior save in place', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-invalid-${stamp}`;
    const goodHtml = '<html><body>good</body></html>';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'save_dashboard', args: { name, html: goodHtml } });

      const { error } = (await callToolError(client, {
        name: 'save_dashboard',
        args: { name, html: 'not html at all' },
      })) as ValidationErrorPayload;
      expect(error.code).toBe('validation');

      const list = (await callTool(client, { name: 'list_dashboards', args: {} })) as Array<Record<string, unknown>>;
      expect(list.some((d) => d.name === name)).toBe(true);
      expect(await fetchStoredHtml(name)).toBe(goodHtml);
    } finally {
      await transport.close();
    }
  });

  it('save_dashboard rejects html with a broken inline <script>', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-broken-script-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const html = '<!doctype html><html><body><script>function( { broken</script></body></html>';
      const { error } = (await callToolError(client, {
        name: 'save_dashboard',
        args: { name, html },
      })) as ValidationErrorPayload;
      expect(error.code).toBe('validation');
      expect(error.issues.some((issue) => issue.includes('syntax error'))).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('delete_dashboard removes the dashboard and it no longer appears in list', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-del-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'save_dashboard', args: { name, html: '<html></html>' } });

      const result = (await callTool(client, { name: 'delete_dashboard', args: { name } })) as { deleted?: boolean };
      expect(result.deleted).toBe(true);

      const list = (await callTool(client, { name: 'list_dashboards', args: {} })) as Array<Record<string, unknown>>;
      expect(list.some((d) => d.name === name)).toBe(false);
      // already deleted — no need to clean up
    } finally {
      await transport.close();
    }
  });

  it('delete_dashboard returns deleted:false for a non-existent name', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'delete_dashboard',
        args: { name: 'dashboard-does-not-exist' },
      })) as { deleted?: boolean };
      expect(result.deleted).toBe(false);
    } finally {
      await transport.close();
    }
  });
});
