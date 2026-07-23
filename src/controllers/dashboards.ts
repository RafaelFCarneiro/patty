import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { findHtmlValidationIssues } from '../logic/dashboard.js';
import * as persistence from '../logic/persistence.js';
import { DASHBOARD_ENTITY_TAG, dashboardErrors, type Dashboard, type DashboardListItem } from '../models/dashboard.js';
import type { FlowOutcome, Persistable } from '../models/persistable.js';
import type { Deps } from './deps.js';

export const saveDashboard = (deps: Deps, name: string, html: string): ResultAsync<FlowOutcome<Dashboard>, AppError> =>
  safeTry(async function* () {
    const issues = findHtmlValidationIssues(html);
    yield* guard(issues.length === 0, dashboardErrors.invalidHtml(issues));

    const ref = await deps.dashboards.findRefByName(name);
    const dashboard: Dashboard = { name, html, updatedAt: deps.clock().toISOString() };

    const persist: Persistable[] =
      ref === null
        ? [persistence.insert({ entity: DASHBOARD_ENTITY_TAG, model: { ...dashboard, id: deps.newId() } })]
        : [
            persistence.update({
              entity: DASHBOARD_ENTITY_TAG,
              model: { ...dashboard, id: ref.id, version: ref.version },
            }),
          ];

    return ok({ persist, response: dashboard });
  });

/** Delete by name is idempotent-by-design — a missing dashboard returns `{ deleted: false }` rather
 *  than an error, with an empty `persist` batch (no write). Mirrors `deleteTag`. */
export const deleteDashboard = (deps: Deps, name: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const ref = await deps.dashboards.findRefByName(name);
    if (!ref) return ok({ persist: [], response: { deleted: false } });

    const persist = [persistence.remove({ entity: DASHBOARD_ENTITY_TAG, id: ref.id, version: ref.version })];
    return ok({ persist, response: { deleted: true } });
  });

/** Preserves the entity's `id` across the rename, unlike `saveDashboard` under a new name (which
 *  would mint a fresh `id` for what the caller means as the same dashboard). */
export const renameDashboard = (
  deps: Deps,
  name: string,
  newName: string,
): ResultAsync<FlowOutcome<Dashboard>, AppError> =>
  safeTry(async function* () {
    const entity = yield* okOr(await deps.dashboards.findByName(name), dashboardErrors.notFound(name));

    // Must precede the guard below — it would otherwise see this row's own name and reject it.
    if (newName === entity.name) {
      return ok({ persist: [], response: { name: entity.name, html: entity.html, updatedAt: entity.updatedAt } });
    }
    yield* guard(!(await deps.dashboards.findRefByName(newName)), dashboardErrors.duplicateName(newName));

    const dashboard: Dashboard = { name: newName, html: entity.html, updatedAt: deps.clock().toISOString() };
    const persist = [
      persistence.update({
        entity: DASHBOARD_ENTITY_TAG,
        model: { ...dashboard, id: entity.id, version: entity.version },
      }),
    ];
    return ok({ persist, response: dashboard });
  });

export const listDashboards = (deps: Deps): Promise<DashboardListItem[]> => deps.dashboards.list();

export const getDashboard = (deps: Deps, name: string): ResultAsync<Dashboard, AppError> =>
  safeTry(async function* () {
    return ok(yield* okOr(await deps.dashboards.get(name), dashboardErrors.notFound(name)));
  });
