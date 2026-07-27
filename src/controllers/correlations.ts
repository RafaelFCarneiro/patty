import { shapeBudgetFitLines, shapeSpendingShifts, shapeUnbudgetedSpend } from '../logic/correlations.js';
import { baselineRange, periodRange } from '../logic/period.js';
import { FindCorrelationsAnalysis, type FindCorrelationsResult, type ResolvedFindCorrelations } from '../models/correlations.js';
import type { Deps } from './deps.js';

/** Unreachable under normal compile-time exhaustiveness; fails loudly instead of silently
 *  returning `undefined` if a future `analysis` case is ever missed. */
const assertNeverAnalysis = (analysis: never): never => {
  throw new Error(`find_correlations: unhandled analysis "${String(analysis)}"`);
};

/** No name resolution, no write, so a plain async function rather than `ResultAsync` — mirrors
 *  `getBudgetStatus`/`getSpendingSummary`. */
export const findCorrelations = async (
  deps: Deps,
  input: ResolvedFindCorrelations,
): Promise<FindCorrelationsResult> => {
  const locale = await deps.locale();

  switch (input.analysis) {
    case FindCorrelationsAnalysis.enum.spending_shifts: {
      const { from: currentFrom, to: currentTo } = periodRange(input);
      const { from: baselineFrom } = baselineRange(input, input.baselineMonths);
      const rows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
      return {
        analysis: FindCorrelationsAnalysis.enum.spending_shifts,
        month: input.month,
        year: input.year,
        shifts: shapeSpendingShifts(rows, input.baselineMonths, input.minDeltaPct, locale),
      };
    }
    case FindCorrelationsAnalysis.enum.budget_fit: {
      const { from: currentFrom, to: currentTo } = periodRange(input);
      const { from: baselineFrom } = baselineRange(input, input.baselineMonths);
      const budgetRows = await deps.correlations.budgetFit(baselineFrom, currentFrom, currentTo);
      const budgeted = shapeBudgetFitLines(budgetRows, input.baselineMonths, input.slackPct, input.overPct, locale);
      // Unbudgeted candidates reuse Phase A's own query (the same per-category baseline the
      // design calls for), excluding whatever `budgeted` already covers.
      const shiftRows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
      return {
        analysis: FindCorrelationsAnalysis.enum.budget_fit,
        month: input.month,
        year: input.year,
        budgeted,
        unbudgeted: shapeUnbudgetedSpend(shiftRows, budgeted, input.baselineMonths, locale),
      };
    }
    default:
      return assertNeverAnalysis(input.analysis);
  }
};
