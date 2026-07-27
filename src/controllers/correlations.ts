import { shapeSpendingShifts } from '../logic/correlations.js';
import { baselineRange, periodRange } from '../logic/period.js';
import { FindCorrelationsAnalysis, type FindCorrelationsResult, type ResolvedFindCorrelations } from '../models/correlations.js';
import type { Deps } from './deps.js';

/** No name resolution, no write, so a plain async function rather than `ResultAsync` — mirrors
 *  `getBudgetStatus`/`getSpendingSummary`. `analysis` is exhaustively switched so a future phase
 *  (B/C/D) adding a member to `FindCorrelationsAnalysis` fails to compile here until handled. */
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
  }
};
