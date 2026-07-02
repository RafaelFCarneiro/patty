import { eq } from 'drizzle-orm';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import { expectPresent, rowNotFoundAfterWrite } from '../present.js';
import type { Dashboard, DashboardListItem } from '../../../models/dashboard.js';
import type { Db } from '../driver.js';
import { dashboards } from '../schema.js';

export type DashboardsRepo = {
  upsert: (name: string, html: string, updatedAt: string) => Promise<Dashboard>;
  get: (name: string) => Promise<Dashboard | null>;
  list: () => Promise<DashboardListItem[]>;
};

export const dashboardsRepo = (db: Db): DashboardsRepo => ({
  upsert: async (name, html, updatedAt) => {
    const [row] = await db
      .insert(dashboards)
      .values({ name, html, updatedAt })
      .onConflictDoUpdate({ target: dashboards.name, set: { html, updatedAt } })
      .returning();
    return dashboardAdapters.dbToModel(expectPresent(row, rowNotFoundAfterWrite('dashboards', 'upsert')));
  },

  get: async (name) => {
    const [row] = await db.select().from(dashboards).where(eq(dashboards.name, name)).limit(1);
    return row ? dashboardAdapters.dbToModel(row) : null;
  },

  list: async () => {
    const rows = await db
      .select({ name: dashboards.name, updatedAt: dashboards.updatedAt })
      .from(dashboards)
      .orderBy(dashboards.name);
    return rows.map(dashboardAdapters.dbToListItem);
  },
});
