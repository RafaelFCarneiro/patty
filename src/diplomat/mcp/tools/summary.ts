import { ToolName } from '../toolName.js';
import { z } from 'zod';
import { getSpendingSummary } from '../../../controllers/summary.js';
import { CurrencyCode } from '../../../models/money.js';
import { defineTool } from '../definition.js';
import { json } from '../respond.js';
import { READ_ONLY } from '../annotations.js';

const getSpendingSummaryDescription =
  'Income, expenses, balance and per-category totals for a month — ' +
  'grouped per currency (BRL/USD are never mixed). Optional displayCurrency adds a top-level ' +
  'converted block: a read-time grand total of expenses across currencies, converted against ' +
  'currency_rates (as_of-stamped, stale-flagged; a currency with no rate to displayCurrency is ' +
  'listed in converted.excluded and left out of the total, never fabricated). Per-currency lines ' +
  'are unaffected either way.';

const getSpendingSummaryTool = defineTool({
  name: ToolName.enum.get_spending_summary,
  config: {
    annotations: READ_ONLY,
    title: 'Get spending summary',
    description: getSpendingSummaryDescription,
    inputSchema: {
      month: z.number().int().min(1).max(12),
      year: z.number().int().min(2000).max(2100),
      displayCurrency: CurrencyCode.optional().describe(
        'Also return a converted grand total of expenses in this currency',
      ),
    },
  },
  handle: async (args, { deps }) => {
    return json(await getSpendingSummary(deps, args, args.displayCurrency));
  },
});

export const summaryTools = [getSpendingSummaryTool];
