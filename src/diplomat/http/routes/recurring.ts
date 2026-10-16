import { z } from 'zod';
import * as recurringAdapters from '../../../adapters/recurring.js';
import * as transactionAdapters from '../../../adapters/transactions.js';
import { applyDueRecurring, createRecurring, listRecurring } from '../../../controllers/recurring.js';
import { RecurringRuleViewSchema } from '../../../models/recurring.js';
import * as wireInRecurring from '../../../wire/in/recurring.js';
import { ApplyDueResultOut } from '../../../wire/out/recurring.js';
import { jsonBody, okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, notFound404, parse, parseOrIssue, send, validation422 } from '../respond.js';
import { READ_SCOPE, WRITE_SCOPE } from '../../../models/auth/scope.js';

const RECURRING_TAG = 'Recurring';
const INVALID_THROUGH_DATE_ISSUE = 'invalid through date';

const listRecurringRoute: RouteDefinition = {
  method: 'get',
  scope: READ_SCOPE,
  path: '/api/recurring',
  tags: [RECURRING_TAG],
  summary: 'List recurring rules',
  responses: { 200: okResponse('Recurring rules', z.array(RecurringRuleViewSchema)) },
  handler: async (_req, _reply, scope) => listRecurring(scope().deps),
};

const createRecurringRoute: RouteDefinition = {
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
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const wireIn = parse(wireInRecurring.CreateRecurringSchema, req.body, reply);
    if (!wireIn) return reply;
    const flow = () =>
      createRecurring(deps, recurringAdapters.wireInToModel(wireIn)).map(recurringAdapters.outcomeToDb);
    return send(reply, await runEffects(flow), 201);
  },
};

const applyDueRecurringRoute: RouteDefinition = {
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
  handler: async (req, reply, scope) => {
    const { deps, runEffects } = scope();
    const input = parseOrIssue(wireInRecurring.ApplyDueBodySchema, req.body ?? {}, reply, INVALID_THROUGH_DATE_ISSUE);
    if (!input) return reply;
    const flow = () =>
      applyDueRecurring(deps, input).map(recurringAdapters.outcomeToDb).map(transactionAdapters.outcomeToDb);
    return send(reply, await runEffects(flow));
  },
};

export const recurringRoutes: RouteDefinition[] = [listRecurringRoute, createRecurringRoute, applyDueRecurringRoute];
