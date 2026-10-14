import type { dashboards } from '../../diplomat/db/schema.js';
import type { WithoutOwner } from './tenancy.js';

// Dashboard row from a Drizzle select — derived from schema.ts (single source of truth).
export type DashboardRow = WithoutOwner<typeof dashboards.$inferSelect>;
