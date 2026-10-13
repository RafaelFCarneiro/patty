import { z } from 'zod';
import * as recurringAdapters from '../../../adapters/recurring.js';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { applyDueRecurring, createRecurring, listRecurring } from '../../../controllers/recurring.js';
import { RecurringRuleViewSchema } from '../../../models/recurring.js';
import * as wireInRecurring from '../../../wire/in/recurring.js';
import { ApplyDueResultOut } from '../../../wire/out/recurring.js';
import type { HttpContext } from '../context.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, notFound404, parse, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const RECURRING_TAG = 'Recurring';

export const recurringRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps, runEffects } = ctx;
  return [
    {
      method: 'get',
      scope: READ_SCOPE,
      path: '/api/recurring',
      tags: [RECURRING_TAG],
      summary: 'List recurring rules',
      responses: { 200: okResponse('Recurring rules', z.array(RecurringRuleViewSchema)) },
      handler: async () => listRecurring(deps),
    },
    {
      method: 'post',
      scope: WRITE_SCOPE,
      path: '/api/recurring',
      tags: [RECURRING_TAG],
      summary: 'Create recurring rule',
      request: { body: jsonBody(wireInRecurring.CreateRecurringSchema) },
      responses: {
        201: okResponse('Recurring rule created', RecurringRuleViewSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(wireInRecurring.CreateRecurringSchema, req.body, reply);
        if (!wireIn) return reply;
        const flow = () =>
          createRecurring(deps, recurringAdapters.wireInToModel(wireIn)).map(recurringAdapters.outcomeToDb);
        return send(reply, await runEffects(flow), 201);
      },
    },
    {
      method: 'post',
      scope: WRITE_SCOPE,
      path: '/api/recurring/apply-due',
      tags: [RECURRING_TAG],
      summary: 'Materialize due recurring rules',
      request: { body: jsonBody(wireInRecurring.ApplyDueBodySchema) },
      responses: {
        200: okResponse('Applied recurring rules', ApplyDueResultOut),
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const q = wireInRecurring.ApplyDueBodySchema.safeParse(req.body ?? {});
        if (!q.success)
          return reply.status(422).send({ error: { code: 'validation', issues: ['invalid through date'] } });
        const flow = () =>
          applyDueRecurring(deps, q.data).map(recurringAdapters.outcomeToDb).map(transactionAdapters.outcomeToDb);
        return send(reply, await runEffects(flow));
      },
    },
  ];
};
