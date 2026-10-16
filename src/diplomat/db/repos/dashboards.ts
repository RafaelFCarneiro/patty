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
import { isUniqueConstraintViolation } from '../sqliteErrors.js';
import { VersionConflict, ownedTableApplier, type EntityApplier } from '../effects.js';
import { ownedWhere, visibleRows, visibleWhere } from '../queries/scope.js';

/** Just enough to build a `Persistable` — presence + `id` + `version`, never the (potentially
 *  ~500KB) `html`. */
export type DashboardRef = { id: string; version: number };

export type DashboardsRepo = {
  get: (name: string) => Promise<Dashboard | null>;
  findRefByName: (name: string) => Promise<DashboardRef | null>;
  isDefault: (name: string) => Promise<boolean>;
  // Full-row read (incl. html) for rename; the user's own dashboard first, else the shared default (`shared: true`).
  findByName: (name: string) => Promise<DashboardEntity | null>;
  list: () => Promise<DashboardListItem[]>;
};

// Resolved relative to this module's own file location (not process.cwd()), same pattern as
// diplomat/db/bootstrap.ts's migrations folder and diplomat/http/routes/ui.ts's UI_ROOT — works
// identically under `tsx src/...` (dev) and `node dist/...` (published package) regardless of cwd.
// src/diplomat/db/repos/dashboards.ts and its compiled dist counterpart are both 4 levels below
// the package root.
export const UI_DASHBOARDS_ROOT = fileURLToPath(new URL('../../../../ui/dashboards', import.meta.url));

export const HTML_FILE_EXTENSION = '.html';

/** Default dashboard files are fixed package assets — never rewritten at runtime — so the first
 *  read of each is cached for the life of the process, same rationale as
 *  diplomat/http/routes/ui.ts's fileContentCache. */
const fileContentCache = new Map<string, string>();

/** Confines a stored `path` strictly within ui/dashboards/ (ADR-027 Phase 2 non-negotiable).
 *  `path` is only ever set by `listDefaultDashboardFiles` below (bootstrap's own directory scan) —
 *  never by user input, since `save_dashboard` always stores `source: inline`, `path: null` — but
 *  this still structurally rules out traversal rather than resting on that invariant alone. */
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

/** Lists the default dashboard files bootstrap should reconcile rows against — every `.html` file
 *  under `ui/dashboards/`, name-sorted for a deterministic seed order. Bare filenames only (no
 *  directory component), which `listDefaultDashboardFiles`'s own caller stores verbatim as `path`. */
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

export const dashboardsRepo = (db: Db, userId: string): DashboardsRepo => {
  const visibleByName = async (name: string) => {
    const [row] = await db
      .select()
      .from(dashboards)
      .where(visibleWhere(dashboards.userId, userId, eq(dashboards.name, name)))
      .orderBy(sql`${dashboards.userId} IS NULL`)
      .limit(1);
    return row;
  };

  return {
    get: async (name) => {
      const row = await visibleByName(name);
      return row ? dashboardAdapters.dbToModel(row, await resolveHtml(row)) : null;
    },

    findRefByName: async (name) => {
      const [row] = await db
        .select({ id: dashboards.id, version: dashboards.version })
        .from(dashboards)
        .where(ownedWhere(dashboards.userId, userId, eq(dashboards.name, name)))
        .limit(1);
      return row ?? null;
    },

    isDefault: async (name) => {
      const [row] = await db
        .select({ id: dashboards.id })
        .from(dashboards)
        .where(and(isNull(dashboards.userId), eq(dashboards.name, name)))
        .limit(1);
      return row !== undefined;
    },

    findByName: async (name) => {
      const row = await visibleByName(name);
      return row ? dashboardAdapters.dbToEntity(row, await resolveHtml(row), row.userId === null) : null;
    },

    list: async () => {
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
    },
  };
};

const versionedDashboardApplier = (userId: string): EntityApplier => ownedTableApplier(dashboards, userId);

/** `dashboards.name` has its own `UNIQUE` constraint now that `id` is the primary key — a
 *  concurrent first save of the same brand-new name mints two different ids, both insert, and the
 *  second raises a real `SQLITE_CONSTRAINT_UNIQUE` `versionedTableApplier`'s id-scoped
 *  `onConflictDoNothing` doesn't swallow. Recognized and rethrown as `VersionConflict`, rolling
 *  back and retrying — the retry's own `findRefByName` then sees the committed row and takes the
 *  update path instead of racing another insert. Structurally identical to `tagApplier`
 *  (`diplomat/db/repos/tags.ts`). `update` gets the same wrapper — `renameDashboard` is the one flow
 *  that changes `name` on an existing row, so a concurrent claim of the same `newName` can raise the
 *  identical `UNIQUE` violation there too; without it, the violation would surface as a raw
 *  exception instead of retrying into a clean `duplicate_name`. `delete` stays plain. */
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
