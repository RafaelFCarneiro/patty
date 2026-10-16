import { ToolName } from '../../../models/tool.js';
import { z } from 'zod';
import { deleteDashboard, listDashboards, renameDashboard, saveDashboard } from '../../../controllers/dashboards.js';
import { RenameDashboardSchema, SaveDashboardSchema } from '../../../models/dashboard.js';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import { defineTool } from '../definition.js';
import { fromResult, json } from '../respond.js';
import { MUTATING, READ_ONLY } from '../annotations.js';

const saveDashboardDescription =
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
  'has a syntax error — fix the reported issue and save again.';

const saveDashboardTool = defineTool({
  name: ToolName.enum.save_dashboard,
  config: {
    annotations: MUTATING,
    title: 'Save dashboard',
    description: saveDashboardDescription,
    inputSchema: SaveDashboardSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => saveDashboard(deps, args.name, args.html).map(dashboardAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const listDashboardsTool = defineTool({
  name: ToolName.enum.list_dashboards,
  config: {
    annotations: READ_ONLY,
    title: 'List dashboards',
    description: 'List saved dashboards by name and last-updated time (HTML content omitted).',
    inputSchema: {},
  },
  handle: async (_args, { deps }) => {
    return json(await listDashboards(deps));
  },
});

const deleteDashboardTool = defineTool({
  name: ToolName.enum.delete_dashboard,
  config: {
    annotations: MUTATING,
    title: 'Delete dashboard',
    description: 'Delete a dashboard by name. Idempotent — deleting an already-absent name is not an error.',
    inputSchema: { name: z.string().min(1).describe('Dashboard name') },
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => deleteDashboard(deps, args.name).map(dashboardAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

const renameDashboardDescription =
  'Rename a dashboard, preserving its content and identity. GET /api/dashboards/:newName serves it ' +
  'afterward; GET /api/dashboards/:name (the old name) 404s. GET /ui/:name always serves the app ' +
  'shell regardless of name, so it does not reflect this — the shell resolves the dashboard ' +
  'client-side.';

const renameDashboardTool = defineTool({
  name: ToolName.enum.rename_dashboard,
  config: {
    annotations: MUTATING,
    title: 'Rename dashboard',
    description: renameDashboardDescription,
    inputSchema: RenameDashboardSchema.shape,
  },
  handle: async (args, { deps, runEffects }) => {
    const flow = () => renameDashboard(deps, args.name, args.newName).map(dashboardAdapters.outcomeToDb);
    return fromResult(await runEffects(flow));
  },
});

export const dashboardTools = [saveDashboardTool, listDashboardsTool, deleteDashboardTool, renameDashboardTool];
