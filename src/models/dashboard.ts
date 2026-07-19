import { z } from 'zod';
import { validation, type NotFound, type ValidationError } from './error.js';

// A generous ceiling for a self-contained, data-less HTML shell (the baseline template is ~23KB)
// — bounds worst-case DB growth and the cost of the render-ability check's vm.Script compile step
// (logic/dashboard.ts) against an oversized save, without constraining realistic dashboard sizes.
export const DASHBOARD_HTML_MAX_LENGTH = 500_000;

export const DashboardSchema = z.object({
  name: z.string().min(1).describe('Dashboard identifier, used as the /ui/:name path segment (e.g. "overview")'),
  html: z
    .string()
    .max(DASHBOARD_HTML_MAX_LENGTH)
    .describe('Self-contained HTML shell. Must fetch data from /api on load — never embeds financial data'),
  updatedAt: z.string().describe('ISO 8601 timestamp of the last save'),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DashboardListItemSchema = DashboardSchema.omit({ html: true });
export type DashboardListItem = z.infer<typeof DashboardListItemSchema>;

export const SaveDashboardSchema = DashboardSchema.pick({ name: true, html: true });
export type SaveDashboard = z.infer<typeof SaveDashboardSchema>;

// The dashboard aggregate owns its own entity tag (docs/functional-core-imperative-shell.md),
// mirroring `models/account.ts`'s `ACCOUNT_ENTITY_TAG` — `models/persistable.ts` is generic over
// any entity's tag/model and never lists this constant itself.
export const DASHBOARD_ENTITY_TAG = 'dashboard';

// The persistence-side entity: `Dashboard` plus the optimistic-concurrency `version` token. Never
// sent over the wire — only `saveDashboard`'s read-decide step and `diplomat/db/repos/dashboards.ts`'s
// `dashboardApplier` speak this shape.
export const DashboardEntitySchema = DashboardSchema.extend({
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type DashboardEntity = z.infer<typeof DashboardEntitySchema>;

export type DashboardError = NotFound<'dashboard'> | ValidationError;

export const dashboardErrors = {
  notFound: (name: string): DashboardError => ({ code: 'unknown_dashboard', query: name, candidates: [] }),
  invalidHtml: (issues: string[]): DashboardError => validation(issues),
};
