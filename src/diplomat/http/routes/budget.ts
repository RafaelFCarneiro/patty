import { z } from 'zod';
import { getBudgetStatus, listBudgets } from '../../../controllers/budgets.js';
import { BudgetViewSchema } from '../../../models/budget.js';
import { CoercedPeriodSchema } from '../../../wire/in/period.js';
import { BudgetStatusOutSchema } from '../../../wire/out/budgets.js';
import type { HttpContext } from '../context.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { parse, validation422 } from '../respond.js';

const BUDGETS_TAG = 'Budgets';

export const budgetRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps } = ctx;
  return [
    {
      method: 'get',
      path: '/api/budgets',
      tags: [BUDGETS_TAG],
      summary: 'List budgets',
      responses: { 200: okResponse('Budgets', z.array(BudgetViewSchema)) },
      handler: async () => listBudgets(deps),
    },
    {
      method: 'get',
      path: '/api/budgets/status',
      tags: [BUDGETS_TAG],
      summary: 'Get budget status',
      request: { query: CoercedPeriodSchema },
      responses: { 200: okResponse('Budget status', BudgetStatusOutSchema), 422: validation422 },
      handler: async (req, reply) => {
        const input = parse(CoercedPeriodSchema, req.query, reply);
        if (!input) return reply;
        return reply.send(await getBudgetStatus(deps, input));
      },
    },
  ];
};
