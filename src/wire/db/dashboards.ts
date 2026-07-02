import type { dashboards } from '../../diplomat/db/schema.js';

// Dashboard row from a Drizzle select — derived from schema.ts (single source of truth).
export type DashboardRow = typeof dashboards.$inferSelect;
