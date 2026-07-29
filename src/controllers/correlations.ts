import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import {
  shapeBudgetFitLines,
  shapeMerchantConcentration,
  shapeSpendingShifts,
  shapeUnbudgetedSpend,
} from '../logic/correlations.js';
import { baselineRange, periodRange } from '../logic/period.js';
import { FindCorrelationsAnalysis, type FindCorrelationsResult, type ResolvedFindCorrelations } from '../models/correlations.js';
import type { Deps } from './deps.js';
import { resolveCategoryRef } from './resolve.js';

/** Unreachable under normal compile-time exhaustiveness; fails loudly instead of silently
 *  returning `undefined` if a future `analysis` case is ever missed. */
const assertNeverAnalysis = (analysis: never): never => {
  throw new Error(`find_correlations: unhandled analysis "${String(analysis)}"`);
};

/** `merchant_concentration`'s optional `category` filter is the only mode that ever resolves a
 *  name, so this is a `safeTry` pipeline (unlike `getBudgetStatus`/`getSpendingSummary`'s plain
 *  async) purely to carry that one failure path. */
export const findCorrelations = (
  deps: Deps,
  input: ResolvedFindCorrelations,
): ResultAsync<FindCorrelationsResult, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();

    switch (input.analysis) {
      case FindCorrelationsAnalysis.enum.spending_shifts: {
        const { from: currentFrom, to: currentTo } = periodRange(input);
        const { from: baselineFrom } = baselineRange(input, input.baselineMonths);
        const rows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
        return ok({
          analysis: FindCorrelationsAnalysis.enum.spending_shifts,
          month: input.month,
          year: input.year,
          shifts: shapeSpendingShifts(rows, input.baselineMonths, input.minDeltaPct, locale),
        });
      }
      case FindCorrelationsAnalysis.enum.budget_fit: {
        const { from: currentFrom, to: currentTo } = periodRange(input);
        const { from: baselineFrom } = baselineRange(input, input.baselineMonths);
        const budgetRows = await deps.correlations.budgetFit(baselineFrom, currentFrom, currentTo);
        const budgeted = shapeBudgetFitLines(budgetRows, input.baselineMonths, input.slackPct, input.overPct, locale);
        // Unbudgeted candidates reuse Phase A's own query, excluding whatever `budgeted` already covers.
        const shiftRows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
        return ok({
          analysis: FindCorrelationsAnalysis.enum.budget_fit,
          month: input.month,
          year: input.year,
          budgeted,
          unbudgeted: shapeUnbudgetedSpend(shiftRows, budgeted, input.baselineMonths, locale),
        });
      }
      case FindCorrelationsAnalysis.enum.merchant_concentration: {
        const { from, to } = periodRange(input);
        const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
        const rows = await deps.correlations.merchantConcentration(from, to, category?.id ?? null);
        return ok({
          analysis: FindCorrelationsAnalysis.enum.merchant_concentration,
          month: input.month,
          year: input.year,
          categories: shapeMerchantConcentration(rows, input.topN, locale),
        });
      }
      default:
        return assertNeverAnalysis(input.analysis);
    }
  });
