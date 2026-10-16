import { getHealth, getStatus } from '../../../controllers/status.js';
import { HealthOut, StatusOut } from '../../../wire/out/status.js';
import type { HttpContext } from '../context.js';
import { HEALTH_PATH } from '../authPaths.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { READ_SCOPE } from '../../../models/auth/scope.js';

const SYSTEM_TAG = 'System';

const healthRoute = (publicDeps: HttpContext['publicDeps']): RouteDefinition => ({
  method: 'get',
  scope: READ_SCOPE,
  path: HEALTH_PATH,
  tags: [SYSTEM_TAG],
  summary: 'Liveness and database probe — the only unauthenticated /api route (ADR-033 §6)',
  responses: { 200: okResponse('OK', HealthOut) },
  handler: async () => getHealth(publicDeps),
});

const statusRoute = (version: string): RouteDefinition => ({
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/status',
  tags: [SYSTEM_TAG],
  summary: 'Server status',
  responses: { 200: okResponse('Server status', StatusOut) },
  handler: async (_req, _reply, scope) => getStatus(scope().deps, version),
});

/** The one module that needs the context: health is public (no principal), status reports the version. */
export const systemRoutes = ({ publicDeps, version }: HttpContext): RouteDefinition[] => [
  healthRoute(publicDeps),
  statusRoute(version),
];
