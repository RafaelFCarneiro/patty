import { z } from 'zod';
import * as dashboardAdapters from '../../../adapters/dashboards.js';
import {
  deleteDashboard,
  getDashboard,
  listDashboards,
  renameDashboard,
  saveDashboard,
} from '../../../controllers/dashboards.js';
import {
  DashboardListItemSchema,
  DashboardSchema,
  RenameDashboardSchema,
  SaveDashboardSchema,
} from '../../../models/dashboard.js';
import { DeletedOut } from '../../../wire/out/common.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, nameParam, notFound404, parse, send, validation422 } from '../respond.js';

const DASHBOARDS_TAG = 'Dashboards';

const renameDashboardBody = RenameDashboardSchema.pick({ newName: true });

export const dashboardRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'get',
      path: '/api/dashboards',
      tags: [DASHBOARDS_TAG],
      summary: 'List dashboards',
      responses: { 200: okResponse('Dashboards (HTML omitted)', z.array(DashboardListItemSchema)) },
      handler: async () => listDashboards(deps),
    },
    {
      method: 'get',
      path: '/api/dashboards/:name',
      tags: [DASHBOARDS_TAG],
      summary: 'Get a dashboard as JSON',
      request: { params: nameParam },
      responses: { 200: okResponse('Dashboard', DashboardSchema), 404: notFound404 },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const result = await getDashboard(deps, name);
        reply.header('cache-control', 'no-cache');
        return send(reply, result);
      },
    },
    {
      method: 'post',
      path: '/api/dashboards',
      tags: [DASHBOARDS_TAG],
      summary: 'Save (upsert) a dashboard',
      request: { body: jsonBody(SaveDashboardSchema) },
      responses: { 200: okResponse('Dashboard saved', DashboardSchema), 422: validation422 },
      handler: async (req, reply) => {
        const wireIn = parse(SaveDashboardSchema, req.body, reply);
        if (!wireIn) return reply;
        const flow = () => saveDashboard(deps, wireIn.name, wireIn.html).map(dashboardAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'delete',
      path: '/api/dashboards/:name',
      tags: [DASHBOARDS_TAG],
      summary: 'Delete dashboard',
      request: { params: nameParam },
      responses: { 200: okResponse('Dashboard deleted', DeletedOut) },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const flow = () => deleteDashboard(deps, name).map(dashboardAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
    {
      method: 'post',
      path: '/api/dashboards/:name/rename',
      tags: [DASHBOARDS_TAG],
      summary: 'Rename a dashboard',
      request: { params: nameParam, body: jsonBody(renameDashboardBody) },
      responses: {
        200: okResponse('Dashboard renamed', DashboardSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const { name } = req.params as { name: string };
        const wireIn = parse(renameDashboardBody, req.body, reply);
        if (!wireIn) return reply;
        const flow = () => renameDashboard(deps, name, wireIn.newName).map(dashboardAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
  ];
};
