import {
  DASHBOARD_ENTITY_TAG,
  DashboardEntitySchema,
  DashboardListItemSchema,
  DashboardSchema,
  DashboardSource,
  type Dashboard,
  type DashboardEntity,
  type DashboardListItem,
} from '../models/dashboard.js';
import * as persistence from '../logic/persistence.js';
import type { DashboardRow } from '../wire/db/dashboards.js';

/** `resolvedHtml` is the content the repo already read — from `row.html` for `source: inline`, or
 *  from `path` under `ui/dashboards/` for `source: file` (the file read is I/O, so it happens in
 *  the repo, never here; this stays a pure field mapping either way). */
export const dbToModel = (row: DashboardRow, resolvedHtml: string): Dashboard =>
  DashboardSchema.parse({ name: row.name, html: resolvedHtml, updatedAt: row.updatedAt, source: row.source });

export const dbToListItem = (row: Pick<DashboardRow, 'name' | 'updatedAt' | 'source'>): DashboardListItem =>
  DashboardListItemSchema.parse({ name: row.name, updatedAt: row.updatedAt, source: row.source });

/** Read variant carrying `id`/`version`/`path` — for `findByName`'s full-row read, which rename needs to
 *  build a version-guarded `Persistable` that preserves the row's source/path unchanged. */
export const dbToEntity = (row: DashboardRow, resolvedHtml: string): DashboardEntity =>
  DashboardEntitySchema.parse({
    id: row.id,
    name: row.name,
    html: resolvedHtml,
    updatedAt: row.updatedAt,
    version: row.version,
    source: row.source,
    path: row.path,
  });

// Not the identity function (unlike most entities' modelToDb): a source: 'file' row's stored
// `html` is always null (content lives on disk) and a source: 'inline' row's stored `path` is
// always null — this is where "exactly one of html/path per source" (ADR-027 Phase 2) is enforced
// on the write side, mirroring the schema's own CHECK constraint.
export const modelToDb = (entity: DashboardEntity): DashboardRow =>
  entity.source === DashboardSource.enum.file
    ? {
        id: entity.id,
        name: entity.name,
        html: null,
        updatedAt: entity.updatedAt,
        version: entity.version,
        source: entity.source,
        path: entity.path,
      }
    : {
        id: entity.id,
        name: entity.name,
        html: entity.html,
        updatedAt: entity.updatedAt,
        version: entity.version,
        source: entity.source,
        path: null,
      };

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(DASHBOARD_ENTITY_TAG, modelToDb);
