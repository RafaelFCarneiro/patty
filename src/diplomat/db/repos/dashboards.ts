import { and, eq } from 'drizzle-orm';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import type { Dashboard, DashboardEntity, DashboardListItem } from '../../../models/dashboard.js';
import type { Db } from '../driver.js';
import { dashboards } from '../schema.js';
import { isPrimaryKeyConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, type EntityApplier } from '../effects.js';

export type DashboardsRepo = {
  get: (name: string) => Promise<Dashboard | null>;
  findRawByName: (name: string) => Promise<DashboardEntity | null>;
  list: () => Promise<DashboardListItem[]>;
};

export const dashboardsRepo = (db: Db): DashboardsRepo => ({
  get: async (name) => {
    const [row] = await db.select().from(dashboards).where(eq(dashboards.name, name)).limit(1);
    return row ? dashboardAdapters.dbToModel(row) : null;
  },

  findRawByName: async (name) => {
    const [row] = await db.select().from(dashboards).where(eq(dashboards.name, name)).limit(1);
    return row ? dashboardAdapters.dbToEntity(row) : null;
  },

  list: async () => {
    const rows = await db
      .select({ name: dashboards.name, updatedAt: dashboards.updatedAt })
      .from(dashboards)
      .orderBy(dashboards.name);
    return rows.map(dashboardAdapters.dbToListItem);
  },
});

// Hand-written rather than `versionedTableApplier` because `dashboards` keys on `name`, not `id`.
// A concurrent first save of the same name raises `SQLITE_CONSTRAINT_PRIMARYKEY` — NOT
// `SQLITE_CONSTRAINT_UNIQUE`, since `name` is the primary key rather than a secondary unique
// column — so it needs `isPrimaryKeyConstraintViolation`, not `isUniqueConstraintViolation`
// (`tagApplier`'s check). Rethrown as `VersionConflict` to roll back and retry.
export const dashboardApplier: EntityApplier = {
  insert: async (tx, model) => {
    const row = model as { name: string; html: string; updatedAt: string };
    try {
      const result = await tx.insert(dashboards).values(row);
      return { applied: (result.rowsAffected ?? 0) > 0 };
    } catch (cause) {
      if (isPrimaryKeyConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },

  update: async (tx, model) => {
    const row = model as { name: string; html: string; updatedAt: string; version: number };
    const result = await tx
      .update(dashboards)
      .set({ html: row.html, updatedAt: row.updatedAt, version: row.version + 1 })
      .where(and(eq(dashboards.name, row.name), eq(dashboards.version, row.version)));
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },

  delete: async (tx, name, version) => {
    const result = await tx.delete(dashboards).where(and(eq(dashboards.name, name), eq(dashboards.version, version)));
    return { applied: (result.rowsAffected ?? 0) > 0 };
  },
};
