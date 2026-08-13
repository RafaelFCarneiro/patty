import { getSpendingSummary } from '../../../controllers/summary.js';
import { SpendingSummaryOut } from '../../../wire/out/summary.js';
import { SummaryQuerySchema } from '../../../wire/in/summary.js';
import type { HttpContext } from '../context.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { parse, validation422 } from '../respond.js';

const SUMMARY_TAG = 'Summary';

export const summaryRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps } = ctx;
  return [
    {
      method: 'get',
      path: '/api/summary',
      tags: [SUMMARY_TAG],
      summary: 'Get spending summary',
      request: { query: SummaryQuerySchema },
      responses: { 200: okResponse('Spending summary', SpendingSummaryOut), 422: validation422 },
      handler: async (req, reply) => {
        const input = parse(SummaryQuerySchema, req.query, reply);
        if (!input) return reply;
        return reply.send(await getSpendingSummary(deps, input, input.displayCurrency));
      },
    },
  ];
};
