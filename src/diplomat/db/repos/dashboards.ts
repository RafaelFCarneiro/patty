import { readdir, readFile } from 'node:fs/promises';
import { resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as R from 'remeda';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import {
  DashboardSource,
  type Dashboard,
  type DashboardEntity,
  type DashboardListItem,
} from '../../../models/dashboard.js';
import type { Db } from '../driver.js';
import { dashboards } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqlite-errors.js';
import { VersionConflict, ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedWhere, visibleRows, visibleWhere, type RepoScope } from '../queries/scope.js';

export type DashboardRef = { id: string; version: number };

export type DashboardsRepo = {
  get: (name: string) => Promise<Dashboard | null>;
  findRefByName: (name: string) => Promise<DashboardRef | null>;
  isDefault: (name: string) => Promise<boolean>;
  findByName: (name: string) => Promise<DashboardEntity | null>;
  list: () => Promise<DashboardListItem[]>;
};

export const UI_DASHBOARDS_ROOT = fileURLToPath(new URL('../../../../ui/dashboards', import.meta.url));

export const HTML_FILE_EXTENSION = '.html';

const fileContentCache = new Map<string, string>();

const resolveDashboardFilePath = (path: string): string => {
  const resolved = resolvePath(UI_DASHBOARDS_ROOT, path);
  if (resolved !== UI_DASHBOARDS_ROOT && !resolved.startsWith(UI_DASHBOARDS_ROOT + sep)) {
    throw new Error(`dashboard file path escapes ui/dashboards/: ${path}`);
  }
  return resolved;
};

const readDashboardFile = async (path: string): Promise<string> => {
  const resolved = resolveDashboardFilePath(path);
  const cached = fileContentCache.get(resolved);
  if (cached !== undefined) return cached;
  const content = await readFile(resolved, 'utf-8');
  fileContentCache.set(resolved, content);
  return content;
};

export const listDefaultDashboardFiles = async (): Promise<string[]> => {
  const entries = await readdir(UI_DASHBOARDS_ROOT, { withFileTypes: true });
  return R.pipe(
    entries,
    R.filter((entry) => entry.isFile() && entry.name.endsWith(HTML_FILE_EXTENSION)),
    R.map((entry) => entry.name),
    R.sortBy(R.identity()),
  );
};

type ResolvableRow = { source: string; html: string | null; path: string | null };

const resolveHtml = (row: ResolvableRow): Promise<string> => {
  if (row.source === DashboardSource.enum.file) {
    if (row.path === null) throw new Error(`dashboard source: file row is missing its path (invariant violation)`);
    return readDashboardFile(row.path);
  }
  if (row.html === null) throw new Error(`dashboard source: inline row is missing its html (invariant violation)`);
  return Promise.resolve(row.html);
};

const visibleByName = async ({ db, userId }: RepoScope, name: string) => {
  const [row] = await db
    .select()
    .from(dashboards)
    .where(visibleWhere(dashboards.userId, userId, eq(dashboards.name, name)))
    .orderBy(sql`${dashboards.userId} IS NULL`)
    .limit(1);
  return row;
};

const get = async (scope: RepoScope, name: string): ReturnType<DashboardsRepo['get']> => {
  const row = await visibleByName(scope, name);
  return row ? dashboardAdapters.dbToModel(row, await resolveHtml(row)) : null;
};

const findRefByName = async ({ db, userId }: RepoScope, name: string): ReturnType<DashboardsRepo['findRefByName']> => {
  const [row] = await db
    .select({ id: dashboards.id, version: dashboards.version })
    .from(dashboards)
    .where(ownedWhere(dashboards.userId, userId, eq(dashboards.name, name)))
    .limit(1);
  return row ?? null;
};

const isDefault = async ({ db }: RepoScope, name: string): ReturnType<DashboardsRepo['isDefault']> => {
  const [row] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(isNull(dashboards.userId), eq(dashboards.name, name)))
    .limit(1);
  return row !== undefined;
};

const findByName = async (scope: RepoScope, name: string): ReturnType<DashboardsRepo['findByName']> => {
  const row = await visibleByName(scope, name);
  return row ? dashboardAdapters.dbToEntity(row, await resolveHtml(row), row.userId === null) : null;
};

const list = async ({ db, userId }: RepoScope): ReturnType<DashboardsRepo['list']> => {
  const own = db.select({ name: dashboards.name }).from(dashboards).where(ownedWhere(dashboards.userId, userId));
  const rows = await db
    .select({ name: dashboards.name, updatedAt: dashboards.updatedAt, source: dashboards.source })
    .from(dashboards)
    .where(
      and(
        visibleRows(dashboards.userId, userId),
        sql`(${dashboards.userId} IS NOT NULL OR ${dashboards.name} NOT IN (${own}))`,
      ),
    )
    .orderBy(dashboards.name);
  return rows.map(dashboardAdapters.dbToListItem);
};

export const dashboardsRepo = (db: Db, userId: string): DashboardsRepo => {
  const scope: RepoScope = { db, userId };
  return {
    get: (name) => get(scope, name),
    findRefByName: (name) => findRefByName(scope, name),
    isDefault: (name) => isDefault(scope, name),
    findByName: (name) => findByName(scope, name),
    list: () => list(scope),
  };
};

const versionedDashboardApplier = (userId: string): EntityApplier => ownedTableApplier(dashboards, userId);

export const dashboardApplier = (userId: string): EntityApplier => {
  const applier = versionedDashboardApplier(userId);
  return {
    ...applier,
    insert: async (tx, model) => {
      try {
        return await applier.insert(tx, model);
      } catch (cause) {
        if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
        throw cause;
      }
    },
    update: async (tx, model) => {
      try {
        return await applier.update(tx, model);
      } catch (cause) {
        if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
        throw cause;
      }
    },
  };
};
