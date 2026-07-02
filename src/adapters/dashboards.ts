import {
  DashboardListItemSchema,
  DashboardSchema,
  type Dashboard,
  type DashboardListItem,
} from '../models/dashboard.js';
import type { DashboardRow } from '../wire/db/dashboards.js';

export const dbToModel = (row: DashboardRow): Dashboard =>
  DashboardSchema.parse({ name: row.name, html: row.html, updatedAt: row.updatedAt });

export const dbToListItem = (row: Pick<DashboardRow, 'name' | 'updatedAt'>): DashboardListItem =>
  DashboardListItemSchema.parse({ name: row.name, updatedAt: row.updatedAt });
