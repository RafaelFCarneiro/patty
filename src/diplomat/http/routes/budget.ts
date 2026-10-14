import { z } from 'zod';
import { getBudgetStatus, listBudgets } from '../../../controllers/budgets.js';
import { BudgetViewSchema } from '../../../models/budget.js';
import { BudgetStatusQuerySchema } from '../../../wire/in/budgets.js';
import { BudgetStatusOutSchema } from '../../../wire/out/budgets.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { parse, validation422 } from '../respond.js';
import { READ_SCOPE } from '../../../models/auth/scope.js';

const BUDGETS_TAG = 'Budgets';

export const budgetRoutes = (): RouteDefinition[] => {
  return [
    {
      method: 'get',
      scope: READ_SCOPE,
      path: '/api/budgets',
      tags: [BUDGETS_TAG],
      summary: 'List budgets',
      responses: { 200: okResponse('Budgets', z.array(BudgetViewSchema)) },
      handler: async (_req, _reply, scope) => {
        const { deps } = scope();
        return listBudgets(deps);
      },
    },
    {
      method: 'get',
      scope: READ_SCOPE,
      path: '/api/budgets/status',
      tags: [BUDGETS_TAG],
      summary: 'Get budget status',
      request: { query: BudgetStatusQuerySchema },
      responses: { 200: okResponse('Budget status', BudgetStatusOutSchema), 422: validation422 },
      handler: async (req, reply, scope) => {
        const { deps } = scope();
        const input = parse(BudgetStatusQuerySchema, req.query, reply);
        if (!input) return reply;
        return reply.send(await getBudgetStatus(deps, input, input.displayCurrency));
      },
    },
  ];
};
