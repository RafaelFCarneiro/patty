import { ok, ResultAsync, safeTry } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import {
  shapeBudgetFitLines,
  shapeMerchantConcentration,
  shapeSpendingShifts,
  shapeUnbudgetedSpend,
} from '../logic/correlations.js';
import { baselineRange, periodRange } from '../logic/period.js';
import { FindCorrelationsAnalysis, type FindCorrelationsResult, type ResolvedFindCorrelations } from '../models/correlations.js';
import type { Locale } from '../models/locale.js';
import type { Deps } from './deps.js';
import { resolveCategoryRef } from './resolve.js';

/** `[baselineFrom, currentFrom)` is the trailing baseline window; `[currentFrom, currentTo)` is
 *  the reference month — shared by `spending_shifts` and `budget_fit`, which both measure against
 *  the same trailing-average definition (Phase A). */
const resolveWindows = (
  input: ResolvedFindCorrelations,
): { baselineFrom: string; currentFrom: string; currentTo: string } => {
  const { from: currentFrom, to: currentTo } = periodRange(input);
  const { from: baselineFrom } = baselineRange(input, input.baselineMonths);
  return { baselineFrom, currentFrom, currentTo };
};

type AnalysisHandler = (
  deps: Deps,
  input: ResolvedFindCorrelations,
  locale: Locale,
) => ResultAsync<FindCorrelationsResult, AppError>;

const spendingShifts: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    const { baselineFrom, currentFrom, currentTo } = resolveWindows(input);
    const rows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.spending_shifts,
      month: input.month,
      year: input.year,
      shifts: shapeSpendingShifts(rows, input.baselineMonths, input.minDeltaPct, locale),
    });
  });

const budgetFit: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    const { baselineFrom, currentFrom, currentTo } = resolveWindows(input);
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
  });

const merchantConcentration: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    const { from, to } = periodRange(input);
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    const rows = await deps.correlations.merchantConcentration(from, to, category?.id ?? null);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.merchant_concentration,
      month: input.month,
      year: input.year,
      categories: shapeMerchantConcentration(rows, input.topN, locale),
    });
  });

/** Exhaustive over `FindCorrelationsAnalysis` — mirrors `aggregateWhitelist.ts`'s
 *  `GROUP_BY_MAP`/`METRIC_MAP` (ADR-011): a member added to the enum without a handler here fails
 *  to compile, so this table is the exhaustiveness mechanism, not `assertNeverAnalysis` below. */
const ANALYSIS_HANDLERS: Record<FindCorrelationsAnalysis, AnalysisHandler> = {
  [FindCorrelationsAnalysis.enum.spending_shifts]: spendingShifts,
  [FindCorrelationsAnalysis.enum.budget_fit]: budgetFit,
  [FindCorrelationsAnalysis.enum.merchant_concentration]: merchantConcentration,
};

/** Only reachable if the MCP boundary's zod validation was somehow bypassed — `ANALYSIS_HANDLERS`
 *  is exhaustive at compile time, so this is a runtime safety net, not the exhaustiveness check. */
const assertNeverAnalysis = (analysis: string): never => {
  throw new Error(`find_correlations: unhandled analysis "${analysis}"`);
};

export const findCorrelations = (
  deps: Deps,
  input: ResolvedFindCorrelations,
): ResultAsync<FindCorrelationsResult, AppError> =>
  ResultAsync.fromSafePromise(deps.locale()).andThen((locale) => {
    const handler = ANALYSIS_HANDLERS[input.analysis] ?? assertNeverAnalysis(input.analysis);
    return handler(deps, input, locale);
  });
