import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { aggregateSpending } from '../../../controllers/aggregate.js';
import { AggregateMetric, AggregateSort, AggregateSpendingSchema, type ResolvedAggregateSpending } from '../../../models/aggregate.js';
import type { McpContext } from '../context.js';
import { fromResult } from '../respond.js';
import { READ_ONLY } from '../annotations.js';

export const registerAggregateTools = (server: McpServer, ctx: McpContext): void => {
  const { deps } = ctx;

  server.registerTool(
    'aggregate_spending',
    {
      annotations: READ_ONLY,
      title: 'Aggregate spending',
      description:
        'Flexible spending aggregation: group transactions by category, account, tag, month, or merchant, ' +
        'measured as sum, count, or avg. Results are per-currency blocks with totals and percentages. ' +
        'Only effective, non-transfer transactions are counted. Provide a period via month+year or from/to date range. ' +
        'Optional displayCurrency adds a top-level converted block: a read-time grand total of the per-currency ' +
        'block totals, converted against currency_rates (as_of-stamped, stale-flagged; a currency with no rate to ' +
        'displayCurrency is listed in converted.excluded and left out of the total, never fabricated). Only attached ' +
        'when metric is sum — count/avg are not coherent cross-currency money totals. Per-currency lines are ' +
        'unaffected either way.',
      inputSchema: {
        ...AggregateSpendingSchema.shape,
        metric: AggregateSpendingSchema.shape.metric.default(AggregateMetric.enum.sum),
        sort: AggregateSpendingSchema.shape.sort.default(AggregateSort.enum.desc),
        limit: AggregateSpendingSchema.shape.limit.default(50),
      },
    },
    async (args) => fromResult(await aggregateSpending(deps, args as ResolvedAggregateSpending)),
  );
};
