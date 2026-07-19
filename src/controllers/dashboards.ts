import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { findHtmlValidationIssues } from '../logic/dashboard.js';
import * as persistence from '../logic/persistence.js';
import { DASHBOARD_ENTITY_TAG, dashboardErrors, type Dashboard, type DashboardListItem } from '../models/dashboard.js';
import type { FlowOutcome, Persistable } from '../models/persistable.js';
import type { Deps } from './deps.js';

/** A functional-core flow (docs/functional-core-imperative-shell.md): still upsert semantics by
 *  name — insert if absent, version-guarded update if present — decided here instead of a DB-side
 *  `onConflictDoUpdate`. The response is the plain saved `Dashboard`: unlike an idempotency-keyed
 *  create, there is no created-vs-existing distinction to derive from the shell's apply outcome —
 *  this always overwrites by name (rule 6). */
export const saveDashboard = (deps: Deps, name: string, html: string): ResultAsync<FlowOutcome<Dashboard>, AppError> =>
  safeTry(async function* () {
    const issues = findHtmlValidationIssues(html);
    yield* guard(issues.length === 0, dashboardErrors.invalidHtml(issues));

    const existing = await deps.dashboards.findRawByName(name);
    const dashboard: Dashboard = { name, html, updatedAt: deps.clock().toISOString() };

    const persist: Persistable[] = existing
      ? [persistence.update({ entity: DASHBOARD_ENTITY_TAG, model: { ...dashboard, version: existing.version } })]
      : [persistence.insert({ entity: DASHBOARD_ENTITY_TAG, model: dashboard })];

    return ok({ persist, response: dashboard });
  });

export const listDashboards = (deps: Deps): Promise<DashboardListItem[]> => deps.dashboards.list();

export const getDashboard = (deps: Deps, name: string): ResultAsync<Dashboard, AppError> =>
  safeTry(async function* () {
    return ok(yield* okOr(await deps.dashboards.get(name), dashboardErrors.notFound(name)));
  });
