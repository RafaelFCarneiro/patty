import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deleteDashboard, listDashboards, renameDashboard, saveDashboard } from '../../../controllers/dashboards.js';
import { RenameDashboardSchema, SaveDashboardSchema } from '../../../models/dashboard.js';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';

export const registerDashboardTools = (server: McpServer, ctx: McpContext): void => {
  const { deps, runEffects } = ctx;

  server.registerTool(
    'save_dashboard',
    {
      title: 'Save dashboard',
      description:
        'Create or override a named dashboard: an HTML shell you author, stored and served live at ' +
        'GET /ui/:name (ADR-013). Upsert semantics — saving to an existing name replaces it immediately, ' +
        'no rebuild or restart needed. CRITICAL: the HTML must NEVER embed financial data, secrets, or ' +
        'tokens inline — render layout/styling only and fetch data client-side from the documented /api ' +
        'endpoints (read the fintrack://openapi resource for the contract) on page load, so the dashboard ' +
        'is always live and safe to share. Rejected (validation error) if the HTML has no <html> root or ' +
        'an inline <script> has a syntax error — fix the reported issue and save again.',
      inputSchema: SaveDashboardSchema.shape,
    },
    async (args) => {
      const flow = () => saveDashboard(deps, args.name, args.html).map(dashboardAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'list_dashboards',
    {
      title: 'List dashboards',
      description: 'List saved dashboards by name and last-updated time (HTML content omitted).',
      inputSchema: {},
    },
    async () => json(await listDashboards(deps)),
  );

  server.registerTool(
    'delete_dashboard',
    {
      title: 'Delete dashboard',
      description: 'Delete a dashboard by name. Idempotent — deleting an already-absent name is not an error.',
      inputSchema: { name: z.string().min(1).describe('Dashboard name') },
    },
    async (args) => {
      const flow = () => deleteDashboard(deps, args.name).map(dashboardAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );

  server.registerTool(
    'rename_dashboard',
    {
      title: 'Rename dashboard',
      description:
        'Rename a dashboard, preserving its content and identity. GET /ui/:newName serves it afterward; ' +
        'GET /ui/:name (the old name) 404s.',
      inputSchema: RenameDashboardSchema.shape,
    },
    async (args) => {
      const flow = () => renameDashboard(deps, args.name, args.newName).map(dashboardAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
