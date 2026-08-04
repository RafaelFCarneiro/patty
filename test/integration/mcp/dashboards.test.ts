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

const fetchStoredDashboardStatus = async (name: string): Promise<number> =>
  (await fetch(new URL(`/api/dashboards/${name}`, new URL(mcpUrl).origin))).status;

describe('MCP integration > dashboards', () => {
  it('save_dashboard upserts and list_dashboards includes it without the html blob', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const saved = (await callTool(client, {
        name: 'save_dashboard',
        args: { name, html: '<section>v1</section>' },
      })) as { name?: string; html?: string; updatedAt?: string };
      expect(saved.name).toBe(name);
      expect(saved.html).toBe('<section>v1</section>');
      expect(saved.updatedAt).toBeTruthy();

      const list = (await callTool(client, { name: 'list_dashboards', args: {} })) as Array<Record<string, unknown>>;
      const entry = list.find((d) => d.name === name);
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty('html');

      const resaved = (await callTool(client, {
        name: 'save_dashboard',
        args: { name, html: '<section>v2</section>' },
      })) as { html?: string };
      expect(resaved.html).toBe('<section>v2</section>');
    } finally {
      await transport.close();
    }
  });

  it('save_dashboard rejects html carrying a full document root and leaves the prior save in place', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-invalid-${stamp}`;
    const goodHtml = '<section>good</section>';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'save_dashboard', args: { name, html: goodHtml } });

      const { error } = (await callToolError(client, {
        name: 'save_dashboard',
        args: { name, html: '<!doctype html><html><body>bad</body></html>' },
      })) as ValidationErrorPayload;
      expect(error.code).toBe('validation');

      const list = (await callTool(client, { name: 'list_dashboards', args: {} })) as Array<Record<string, unknown>>;
      expect(list.some((d) => d.name === name)).toBe(true);
      expect(await fetchStoredHtml(name)).toBe(goodHtml);
    } finally {
      await transport.close();
    }
  });

  it('save_dashboard rejects an external <script src> reference', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-external-script-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const html = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>';
      const { error } = (await callToolError(client, {
        name: 'save_dashboard',
        args: { name, html },
      })) as ValidationErrorPayload;
      expect(error.code).toBe('validation');
      expect(error.issues.some((issue) => issue.includes('no external <script src>'))).toBe(true);
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
      const html = '<section><script>function( { broken</script></section>';
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
      await callTool(client, { name: 'save_dashboard', args: { name, html: '<section></section>' } });

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

  it('rename_dashboard preserves content: GET /api/dashboards/:newName serves it, :name 404s', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-rename-${stamp}`;
    const newName = `mcp-dash-renamed-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'save_dashboard', args: { name, html: '<section>keep me</section>' } });

      const renamed = (await callTool(client, {
        name: 'rename_dashboard',
        args: { name, newName },
      })) as { name?: string; html?: string };
      expect(renamed.name).toBe(newName);
      expect(renamed.html).toBe('<section>keep me</section>');

      expect(await fetchStoredHtml(newName)).toBe('<section>keep me</section>');
      expect(await fetchStoredDashboardStatus(name)).toBe(404);
    } finally {
      await transport.close();
    }
  });

  it('rename_dashboard returns unknown_dashboard when the current name does not exist', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const { error } = (await callToolError(client, {
        name: 'rename_dashboard',
        args: { name: 'dashboard-does-not-exist', newName: 'whatever' },
      })) as { error: { code: string } };
      expect(error.code).toBe('unknown_dashboard');
    } finally {
      await transport.close();
    }
  });

  it('rename_dashboard rejects a newName already in use', async () => {
    const stamp = Date.now();
    const nameA = `mcp-dash-rename-a-${stamp}`;
    const nameB = `mcp-dash-rename-b-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'save_dashboard', args: { name: nameA, html: '<section></section>' } });
      await callTool(client, { name: 'save_dashboard', args: { name: nameB, html: '<section></section>' } });

      const { error } = (await callToolError(client, {
        name: 'rename_dashboard',
        args: { name: nameA, newName: nameB },
      })) as { error: { code: string } };
      expect(error.code).toBe('duplicate_name');
    } finally {
      await transport.close();
    }
  });

  it('rename_dashboard to its own current name is a no-op, not a duplicate_name error', async () => {
    const stamp = Date.now();
    const name = `mcp-dash-rename-self-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'save_dashboard', args: { name, html: '<section></section>' } });

      const result = (await callTool(client, {
        name: 'rename_dashboard',
        args: { name, newName: name },
      })) as { name?: string };
      expect(result.name).toBe(name);
    } finally {
      await transport.close();
    }
  });
});
