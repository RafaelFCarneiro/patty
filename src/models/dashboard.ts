import { z } from 'zod';
import type { NotFound } from './error.js';

export const DashboardSchema = z.object({
  name: z.string().min(1).describe('Dashboard identifier, used as the /ui/:name path segment (e.g. "overview")'),
  html: z
    .string()
    .describe('Self-contained HTML shell. Must fetch data from /api on load — never embeds financial data'),
  updatedAt: z.string().describe('ISO 8601 timestamp of the last save'),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const DashboardListItemSchema = DashboardSchema.omit({ html: true });
export type DashboardListItem = z.infer<typeof DashboardListItemSchema>;

export const SaveDashboardSchema = DashboardSchema.pick({ name: true, html: true });
export type SaveDashboard = z.infer<typeof SaveDashboardSchema>;

export type DashboardError = NotFound<'dashboard'>;

export const dashboardErrors = {
  notFound: (name: string): DashboardError => ({ code: 'unknown_dashboard', query: name, candidates: [] }),
};
