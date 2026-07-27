import { shapeSpendingShifts } from '../logic/correlations.js';
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
    default:
      return assertNeverAnalysis(input.analysis);
  }
};
