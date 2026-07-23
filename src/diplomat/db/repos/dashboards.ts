import { eq } from 'drizzle-orm';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import type { Dashboard, DashboardEntity, DashboardListItem } from '../../../models/dashboard.js';
import type { Db } from '../driver.js';
import { dashboards } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

/** Just enough to build a `Persistable` — presence + `id` + `version`, never the (potentially
 *  ~500KB) `html`. */
export type DashboardRef = { id: string; version: number };

export type DashboardsRepo = {
  get: (name: string) => Promise<Dashboard | null>;
  findRefByName: (name: string) => Promise<DashboardRef | null>;
  // Full-row read (incl. html) — for rename, which must re-emit the whole row under a new name.
  findByName: (name: string) => Promise<DashboardEntity | null>;
  list: () => Promise<DashboardListItem[]>;
};

export const dashboardsRepo = (db: Db): DashboardsRepo => ({
  get: async (name) => {
    const [row] = await db.select().from(dashboards).where(eq(dashboards.name, name)).limit(1);
    return row ? dashboardAdapters.dbToModel(row) : null;
  },

  findRefByName: async (name) => {
    const [row] = await db
      .select({ id: dashboards.id, version: dashboards.version })
      .from(dashboards)
      .where(eq(dashboards.name, name))
      .limit(1);
    return row ?? null;
  },

  findByName: async (name) => {
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

const versionedDashboardApplier = versionedTableApplier(dashboards);

/** `dashboards.name` has its own `UNIQUE` constraint now that `id` is the primary key — a
 *  concurrent first save of the same brand-new name mints two different ids, both insert, and the
 *  second raises a real `SQLITE_CONSTRAINT_UNIQUE` `versionedTableApplier`'s id-scoped
 *  `onConflictDoNothing` doesn't swallow. Recognized and rethrown as `VersionConflict`, rolling
 *  back and retrying — the retry's own `findRefByName` then sees the committed row and takes the
 *  update path instead of racing another insert. Structurally identical to `tagApplier`
 *  (`diplomat/db/repos/tags.ts`). `update`/`delete` stay plain. */
export const dashboardApplier: EntityApplier = {
  ...versionedDashboardApplier,
  insert: async (tx, model) => {
    try {
      return await versionedDashboardApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
