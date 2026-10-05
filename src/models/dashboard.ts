import { z } from 'zod';
import { Id } from './id.js';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { validation, type DuplicateName, type NotFound, type ValidationError } from './error.js';

// A generous ceiling for a data-less dashboard fragment (the baseline template is ~20KB, down from
// ~30KB pre-ADR-027 now that shared chrome/CSS/Chart.js moved to the shell) — bounds worst-case DB
// growth and the cost of the render-ability check's vm.Script compile step (logic/dashboard.ts)
// against an oversized save, without constraining realistic dashboard sizes.
export const DASHBOARD_HTML_MAX_LENGTH = 500_000;

// ADR-027 Phase 2: `source` is the sole default/custom discriminator (no separate `kind` column).
// `file` — content resolved from a repo-relative .html file under ui/dashboards/ at read time;
// only bootstrap ever registers one (never save_dashboard — see dashboardErrors/saveDashboard).
// `inline` — content stored in the `dashboards.html` column, as before Phase 2.
export const DashboardSource = z.enum(['inline', 'file']);
export type DashboardSourceType = z.infer<typeof DashboardSource>;

export const DashboardSchema = z.object({
  name: z.string().min(1).describe('Dashboard identifier, used as the /ui/:name path segment (e.g. "overview")'),
  html: z
    .string()
    .max(DASHBOARD_HTML_MAX_LENGTH)
    .describe(
      "Content fragment (sections + script) rendered into the app shell's #content (GET /ui) — not a full " +
        'HTML page: no <!doctype>/<html>/<head>/<style> root, the shell already provides those. Must fetch ' +
        'data from /api on load — never embeds financial data',
    ),
  updatedAt: z.string().describe('ISO 8601 timestamp of the last save'),
  source: DashboardSource.describe(
    'inline: DB-stored, editable via save_dashboard. file: a bundled default read from ui/dashboards/, ' +
      'read-only at the install location (ADR-027 Phase 2)',
  ),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DashboardListItemSchema = DashboardSchema.omit({ html: true });
export type DashboardListItem = z.infer<typeof DashboardListItemSchema>;

export const SaveDashboardSchema = DashboardSchema.pick({ name: true, html: true });
export type SaveDashboard = z.infer<typeof SaveDashboardSchema>;

export const RenameDashboardSchema = z.object({
  name: DashboardSchema.shape.name.describe('Current dashboard name'),
  newName: DashboardSchema.shape.name.describe('New dashboard name'),
});
export type RenameDashboard = z.infer<typeof RenameDashboardSchema>;

export const DASHBOARD_ENTITY_TAG = 'dashboard';

export const DashboardEntitySchema = withPersistenceMeta(DashboardSchema).extend({
  id: Id.describe('internal; never on wire/out'),
  path: z
    .string()
    .nullable()
    .describe(
      'internal; never on wire/out. Repo-relative filename under ui/dashboards/ for source: file rows, ' +
        'always null for source: inline (ADR-027 Phase 2)',
    ),
});
export type DashboardEntity = z.infer<typeof DashboardEntitySchema>;

export type DashboardError = NotFound<'dashboard'> | DuplicateName<'dashboard'> | ValidationError;

export const dashboardErrors = {
  notFound: (name: string): DashboardError => ({ code: 'unknown_dashboard', query: name, candidates: [] }),
  invalidHtml: (issues: string[]): DashboardError => validation(issues),
  duplicateName: (name: string): DashboardError => ({ code: 'duplicate_name', entity: 'dashboard', name }),
};
