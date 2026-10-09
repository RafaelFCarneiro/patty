import { aggregateSpending } from '../../../controllers/aggregate.js';
import { AggregateResultSchema } from '../../../models/aggregate.js';
import { AggregateSpendingInputSchema } from '../../../wire/in/aggregate.js';
import type { HttpContext } from '../context.js';
import { okResponse, type RouteDefinition } from '../openapi.js';
import { conflict409, notFound404, parse, send, validation422 } from '../respond.js';
import { READ_SCOPE } from '../../../models/auth.js';

const AGGREGATE_TAG = 'Aggregate';

export const aggregateRoutes = (ctx: HttpContext): RouteDefinition[] => {
  const { deps } = ctx;
  return [
    {
      method: 'get',
      scope: READ_SCOPE,
      path: '/api/aggregate',
      tags: [AGGREGATE_TAG],
      summary: 'Aggregate spending',
      request: { query: AggregateSpendingInputSchema },
      responses: {
        200: okResponse('Aggregated spending', AggregateResultSchema),
        404: notFound404,
        409: conflict409,
        422: validation422,
      },
      handler: async (req, reply) => {
        const wireIn = parse(AggregateSpendingInputSchema, req.query, reply);
        if (!wireIn) return reply;
        return send(reply, await aggregateSpending(deps, wireIn));
      },
    },
  ];
};
