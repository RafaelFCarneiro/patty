import { ToolName } from '../../../models/tool.js';
import { aggregateSpending } from '../../../controllers/aggregate.js';
import {
  AggregateMetric,
  AggregateSort,
  AggregateSpendingSchema,
  type ResolvedAggregateSpending,
} from '../../../models/aggregate.js';
import { defineTool } from '../definition.js';
import { fromResult } from '../respond.js';
import { READ_ONLY } from '../annotations.js';

const aggregateSpendingDescription =
  'Flexible spending aggregation: group transactions by category, account, tag, month, or merchant, ' +
  'measured as sum, count, or avg. Results are per-currency blocks with totals and percentages. ' +
  'Only effective, non-transfer transactions are counted. Provide a period via month+year or from/to date range. ' +
  'Optional displayCurrency adds a top-level converted block: a read-time grand total of the per-currency ' +
  'block totals, converted against currency_rates (as_of-stamped, stale-flagged; a currency with no rate to ' +
  'displayCurrency is listed in converted.excluded and left out of the total, never fabricated). Only attached ' +
  'when metric is sum — count/avg are not coherent cross-currency money totals. Per-currency lines are ' +
  'unaffected either way.';

const aggregateSpendingTool = defineTool({
  name: ToolName.enum.aggregate_spending,
  config: {
    annotations: READ_ONLY,
    title: 'Aggregate spending',
    description: aggregateSpendingDescription,
    inputSchema: {
      ...AggregateSpendingSchema.shape,
      metric: AggregateSpendingSchema.shape.metric.default(AggregateMetric.enum.sum),
      sort: AggregateSpendingSchema.shape.sort.default(AggregateSort.enum.desc),
      limit: AggregateSpendingSchema.shape.limit.default(50),
    },
  },
  handle: async (args, { deps }) => {
    return fromResult(await aggregateSpending(deps, args as ResolvedAggregateSpending));
  },
});

export const aggregateTools = [aggregateSpendingTool];
