import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deleteDashboard, listDashboards, renameDashboard, saveDashboard } from '../../../controllers/dashboards.js';
import { RenameDashboardSchema, SaveDashboardSchema } from '../../../models/dashboard.js';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import type { McpContext } from '../context.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

export const registerDashboardTools = (server: McpServer, ctx: McpContext): void => {
  const { deps, runEffects } = ctx;

  server.registerTool(
    'save_dashboard',
    {
      annotations: MUTATING,
      title: 'Save dashboard',
      description:
        'Create or override a named dashboard: a content FRAGMENT you author (sections + an inline ' +
        '<script>, no <!doctype>/<html>/<head>/<style> root — the app shell at GET /ui already provides ' +
        'those and is what actually renders it, at GET /ui/:name) (ADR-013, fragment model ADR-027). ' +
        'Upsert semantics — saving to an existing name replaces it immediately, no rebuild or restart ' +
        'needed. CRITICAL: the fragment must NEVER embed financial data, secrets, or tokens inline — ' +
        'render layout/styling only and fetch data client-side from the documented /api endpoints (read ' +
        'the fintrack://openapi resource for the contract) on load, so the dashboard is always live and ' +
        'safe to share. Rejected (validation error) if the content is empty, still carries a full ' +
        '<!doctype>/<html> document root, an external <script src> reference (the shell already loads ' +
        'Chart.js once — a fragment carries zero external references of its own), or an inline <script> ' +
        'has a syntax error — fix the reported issue and save again.',
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
      annotations: READ_ONLY,
      title: 'List dashboards',
      description: 'List saved dashboards by name and last-updated time (HTML content omitted).',
      inputSchema: {},
    },
    async () => json(await listDashboards(deps)),
  );

  server.registerTool(
    'delete_dashboard',
    {
      annotations: MUTATING,
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
      annotations: MUTATING,
      title: 'Rename dashboard',
      description:
        'Rename a dashboard, preserving its content and identity. GET /api/dashboards/:newName serves it ' +
        "afterward; GET /api/dashboards/:name (the old name) 404s. GET /ui/:name always serves the app " +
        'shell regardless of name, so it does not reflect this — the shell resolves the dashboard ' +
        'client-side.',
      inputSchema: RenameDashboardSchema.shape,
    },
    async (args) => {
      const flow = () => renameDashboard(deps, args.name, args.newName).map(dashboardAdapters.outcomeToDb);
      return fromResult(await runEffects(flow));
    },
  );
};
