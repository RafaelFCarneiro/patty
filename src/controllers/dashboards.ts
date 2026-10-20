import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { findHtmlValidationIssues } from '../logic/dashboard.js';
import * as persistence from '../logic/persistence.js';
import {
  DASHBOARD_ENTITY_TAG,
  DashboardSource,
  dashboardErrors,
  type Dashboard,
  type DashboardListItem,
} from '../models/dashboard.js';
import { sharedDefaultErrors } from '../models/tenancy.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { Deps } from './deps.js';

export const saveDashboard = (deps: Deps, name: string, html: string): ResultAsync<FlowOutcome<Dashboard>, AppError> =>
  safeTry(async function* () {
    const issues = findHtmlValidationIssues(html);
    yield* guard(issues.length === 0, dashboardErrors.invalidHtml(issues));

    const ref = await deps.dashboards.findRefByName(name);
    const dashboard: Dashboard = {
      name,
      html,
      updatedAt: deps.clock().toISOString(),
      source: DashboardSource.enum.inline,
    };

    const persist: Persistable[] =
      ref === null
        ? [
            persistence.insert({
              entity: DASHBOARD_ENTITY_TAG,
              model: { ...dashboard, id: deps.newId(), path: null, shared: false },
            }),
          ]
        : [
            persistence.update({
              entity: DASHBOARD_ENTITY_TAG,
              model: { ...dashboard, id: ref.id, version: ref.version, path: null, shared: false },
            }),
          ];

    return ok({ persist, response: dashboard });
  });

export const deleteDashboard = (deps: Deps, name: string): ResultAsync<FlowOutcome<{ deleted: boolean }>, AppError> =>
  safeTry(async function* () {
    const ref = await deps.dashboards.findRefByName(name);
    if (!ref) {
      yield* guard(!(await deps.dashboards.isDefault(name)), sharedDefaultErrors.readOnly);
      return ok({ persist: [], response: { deleted: false } });
    }

    const persist = [persistence.remove({ entity: DASHBOARD_ENTITY_TAG, id: ref.id, version: ref.version })];
    return ok({ persist, response: { deleted: true } });
  });

export const renameDashboard = (
  deps: Deps,
  name: string,
  newName: string,
): ResultAsync<FlowOutcome<Dashboard>, AppError> =>
  safeTry(async function* () {
    const entity = yield* okOr(await deps.dashboards.findByName(name), dashboardErrors.notFound(name));
    yield* guard(!entity.shared, sharedDefaultErrors.readOnly);

    if (newName === entity.name) {
      return ok({
        persist: [],
        response: { name: entity.name, html: entity.html, updatedAt: entity.updatedAt, source: entity.source },
      });
    }
    yield* guard(!(await deps.dashboards.findRefByName(newName)), dashboardErrors.duplicateName(newName));

    const dashboard: Dashboard = {
      name: newName,
      html: entity.html,
      updatedAt: deps.clock().toISOString(),
      source: entity.source,
    };
    const persist = [
      persistence.update({
        entity: DASHBOARD_ENTITY_TAG,
        model: { ...dashboard, id: entity.id, version: entity.version, path: entity.path, shared: false },
      }),
    ];
    return ok({ persist, response: dashboard });
  });

export const listDashboards = (deps: Deps): Promise<DashboardListItem[]> => deps.dashboards.list();

export const getDashboard = (deps: Deps, name: string): ResultAsync<Dashboard, AppError> =>
  safeTry(async function* () {
    return ok(yield* okOr(await deps.dashboards.get(name), dashboardErrors.notFound(name)));
  });
