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

export type DashboardError = NotFound<'dashboard'> | ValidationError;

export const dashboardErrors = {
  notFound: (name: string): DashboardError => ({ code: 'unknown_dashboard', query: name, candidates: [] }),
  invalidHtml: (issues: string[]): DashboardError => validation(issues),
};
