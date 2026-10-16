import { ToolName } from '../toolName.js';
import { findCorrelations } from '../../../controllers/correlations.js';
import {
  DEFAULT_BASELINE_MONTHS,
  DEFAULT_LOOKBACK_MONTHS,
  DEFAULT_MIN_DELTA_PCT,
  DEFAULT_MIN_OCCURRENCES,
  DEFAULT_OVER_PCT,
  DEFAULT_SLACK_PCT,
  DEFAULT_TOP_N,
  FindCorrelationsSchema,
  NEW_CATEGORY_ALWAYS_SURFACED_NOTE,
  type ResolvedFindCorrelations,
} from '../../../models/correlations.js';
import { defineTool } from '../definition.js';
import { fromResult } from '../respond.js';
import { READ_ONLY } from '../annotations.js';

const findCorrelationsDescription =
  'Analysis tool over spending patterns, discriminated by `analysis` (Feature Design 016). ' +
  '`spending_shifts`, `budget_fit`, and `merchant_concentration` take a reference `month`/`year`; ' +
  '`recurring_candidates` does not — it scans a rolling `lookbackMonths` window ending today instead. ' +
  '`spending_shifts`: what is up or down vs a trailing baseline, per (category, ' +
  'currency) — "what\'s driving the change" this month. `current` is the reference month\'s effective, ' +
  'expense-only total; `baseline` is the average monthly total over the preceding `baselineMonths`; ' +
  '`deltaPct` is the percentage change, `null` for a brand-new category with no baseline spend at all ' +
  '(reported with `direction: "up"`, not a divide-by-zero). Only categories at or above `minDeltaPct` ' +
  `are returned; ${NEW_CATEGORY_ALWAYS_SURFACED_NOTE}. Results are sorted by ` +
  '|deltaPct| descending. Sub-category spend rolls up into its parent category, same as ' +
  'aggregate_spending/budgets. Per-currency — BRL and USD are never mixed. ' +
  '`budget_fit`: closes the loop between insights and budgets — read-only, apply a suggestion yourself ' +
  'via create_budget/update_budget. `budgeted` has one line per existing budget: `baseline` (same ' +
  "trailing-average definition as spending_shifts) compared to the budget's own `limit` yields a " +
  '`verdict` — "realistic" (baseline within tolerance of limit), "unrealistic" (baseline materially ' +
  'over limit — consistently over-budget, use `overPct`), or "generous" (baseline well under limit, ' +
  'use `slackPct`) — plus a `suggestedLimit` (baseline plus a small margin) you can pass straight to ' +
  'update_budget. `unbudgeted` lists categories with an established (nonzero baseline) spend pattern ' +
  'but no budget at all, each with a `suggestedLimit` ready for create_budget. ' +
  '`merchant_concentration`: within each category (or just one, via `category`), the top `topN` ' +
  'merchants by effective expense, each `share` (spent / categoryTotal, a 0-1 fraction) and ' +
  '`cumulativeShare` (running total in descending-spend order) — "where within Food is my money ' +
  'actually going?" `othersSpent` is categoryTotal minus the returned merchants, the long tail beyond ' +
  '`topN`. A transaction with no classified merchant groups under a localized "Unknown". ' +
  '`recurring_candidates`: merchants with a regular ~monthly cadence over the trailing `lookbackMonths` ' +
  '(default ' +
  `${DEFAULT_LOOKBACK_MONTHS}) that are not already backing a recurring rule (exact ` +
  '`merchant_key` match, Feature Design 017) — each candidate is a ready-to-confirm create_recurring ' +
  `shape: pass its \`merchant\`, \`typicalAmount\`, \`currency\`, \`category\`, and \`suggestedNextDue\` ` +
  'straight through as `merchant`/`amount`/`currency`/`category`/`startDate`. Requires at least ' +
  '`minOccurrences` (default ' +
  `${DEFAULT_MIN_OCCURRENCES}) qualifying transactions at a consistent ~30-day gap and a stable amount ` +
  '— irregular gaps or amount drift disqualify a merchant. ' +
  'Optional `displayCurrency` adds a top-level `converted` block — `{ displayCurrency, total, stale, ' +
  'asOf, excluded }` — a read-time grand total converted against currency_rates (as_of-stamped, ' +
  'stale-flagged; a currency with no rate to `displayCurrency` is listed in `converted.excluded` and ' +
  "left out of the total, never fabricated). Applies to `spending_shifts` (the reference month's " +
  'effective expense spend per currency), `budget_fit` (committed — effective + pending — spend matched ' +
  'to a budget, the same measure get_budget_status converts, so the two surfaces agree), and ' +
  "`merchant_concentration` (each currency's categoryTotal, summed once — not each merchant line). " +
  '`recurring_candidates` is unaffected — its candidates are proposed rules, not per-currency spend ' +
  'totals. Per-currency/per-line results are unaffected either way.';

const findCorrelationsTool = defineTool({
  name: ToolName.enum.find_correlations,
  config: {
    annotations: READ_ONLY,
    title: 'Find correlations',
    description: findCorrelationsDescription,
    inputSchema: {
      ...FindCorrelationsSchema.shape,
      baselineMonths: FindCorrelationsSchema.shape.baselineMonths.default(DEFAULT_BASELINE_MONTHS),
      minDeltaPct: FindCorrelationsSchema.shape.minDeltaPct.default(DEFAULT_MIN_DELTA_PCT),
      slackPct: FindCorrelationsSchema.shape.slackPct.default(DEFAULT_SLACK_PCT),
      overPct: FindCorrelationsSchema.shape.overPct.default(DEFAULT_OVER_PCT),
      topN: FindCorrelationsSchema.shape.topN.default(DEFAULT_TOP_N),
      lookbackMonths: FindCorrelationsSchema.shape.lookbackMonths.default(DEFAULT_LOOKBACK_MONTHS),
      minOccurrences: FindCorrelationsSchema.shape.minOccurrences.default(DEFAULT_MIN_OCCURRENCES),
    },
  },
  handle: async (args, { deps }) => {
    return fromResult(await findCorrelations(deps, args as ResolvedFindCorrelations));
  },
});

export const correlationsTools = [findCorrelationsTool];
