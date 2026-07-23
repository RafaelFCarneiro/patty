import {
  DASHBOARD_ENTITY_TAG,
  DashboardEntitySchema,
  DashboardListItemSchema,
  DashboardSchema,
  type Dashboard,
  type DashboardEntity,
  type DashboardListItem,
} from '../models/dashboard.js';
import * as persistence from '../logic/persistence.js';
import type { DashboardRow } from '../wire/db/dashboards.js';

export const dbToModel = (row: DashboardRow): Dashboard =>
  DashboardSchema.parse({ name: row.name, html: row.html, updatedAt: row.updatedAt });

export const dbToListItem = (row: Pick<DashboardRow, 'name' | 'updatedAt'>): DashboardListItem =>
  DashboardListItemSchema.parse({ name: row.name, updatedAt: row.updatedAt });

/** Read variant carrying `id`/`version` — for `findByName`'s full-row read, which rename needs to
 *  build a version-guarded `Persistable`. */
export const dbToEntity = (row: DashboardRow): DashboardEntity =>
  DashboardEntitySchema.parse({
    id: row.id,
    name: row.name,
    html: row.html,
    updatedAt: row.updatedAt,
    version: row.version,
  });

// Identity: a versioned Dashboard is already row-shaped.
export const modelToDb = (entity: DashboardEntity): DashboardRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(DASHBOARD_ENTITY_TAG, modelToDb);
