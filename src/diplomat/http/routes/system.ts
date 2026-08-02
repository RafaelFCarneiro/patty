import { getStatus } from '../../../controllers/status.js';
import { HealthOut, StatusOut } from '../../../wire/out/status.js';
import type { HttpContext } from '../context.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { RouteTag } from '../respond.js';

export const systemRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, version } = ctx;
  return [
    {
      method: 'get',
      path: '/api/health',
      tags: [RouteTag.system],
      summary: 'Liveness probe',
      responses: { 200: okResponse('OK', HealthOut) },
      handler: async () => ({ status: 'ok' }),
    },
    {
      method: 'get',
      path: '/api/status',
      tags: [RouteTag.system],
      summary: 'Server status',
      responses: { 200: okResponse('Server status', StatusOut) },
      handler: async () => getStatus(deps, version),
    },
  ];
};
