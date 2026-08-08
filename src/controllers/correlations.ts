import { errAsync, ok, ResultAsync, safeTry } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import {
  shapeBudgetFitLines,
  shapeMerchantConcentration,
  shapeRecurringCandidates,
  shapeSpendingShifts,
  shapeUnbudgetedSpend,
} from '../logic/correlations.js';
import { baselineRange, hasPeriod, lookbackFrom, periodRange, toIsoDate } from '../logic/period.js';
import {
  findCorrelationsErrors,
  FindCorrelationsAnalysis,
  type FindCorrelationsResult,
  type ResolvedFindCorrelations,
} from '../models/correlations.js';
import type { Period } from '../models/date.js';
import type { Locale } from '../models/locale.js';
import type { Deps } from './deps.js';
import { resolveCategoryRef } from './resolve.js';

// Safe only where the caller already ran `guard(hasPeriod(input), ...)`.
const resolvePeriod = (input: ResolvedFindCorrelations): Period => ({ month: input.month!, year: input.year! });

const resolveWindows = (
  period: Period,
  baselineMonths: number,
): { baselineFrom: string; currentFrom: string; currentTo: string } => {
  const { from: currentFrom, to: currentTo } = periodRange(period);
  const { from: baselineFrom } = baselineRange(period, baselineMonths);
  return { baselineFrom, currentFrom, currentTo };
};

type AnalysisHandler = (
  deps: Deps,
  input: ResolvedFindCorrelations,
  locale: Locale,
) => ResultAsync<FindCorrelationsResult, AppError>;

const spendingShifts: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    yield* guard(hasPeriod(input), findCorrelationsErrors.missingPeriod(input.analysis));
    const period = resolvePeriod(input);
    const { baselineFrom, currentFrom, currentTo } = resolveWindows(period, input.baselineMonths);
    const rows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.spending_shifts,
      month: period.month,
      year: period.year,
      shifts: shapeSpendingShifts(rows, input.baselineMonths, input.minDeltaPct, locale),
    });
  });

const budgetFit: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    yield* guard(hasPeriod(input), findCorrelationsErrors.missingPeriod(input.analysis));
    const period = resolvePeriod(input);
    const { baselineFrom, currentFrom, currentTo } = resolveWindows(period, input.baselineMonths);
    // shiftRows reuses Phase A's own query to find unbudgeted candidates, excluding what `budgeted` covers.
    const [budgets, windowedSpend, shiftRows] = await Promise.all([
      deps.budgets.list(),
      deps.transactions.spendByCategoryWindowed(baselineFrom, currentFrom, currentTo),
      deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo),
    ]);
    const budgeted = shapeBudgetFitLines(
      budgets,
      windowedSpend,
      input.baselineMonths,
      input.slackPct,
      input.overPct,
      locale,
    );
    return ok({
      analysis: FindCorrelationsAnalysis.enum.budget_fit,
      month: period.month,
      year: period.year,
      budgeted,
      unbudgeted: shapeUnbudgetedSpend(shiftRows, budgeted, input.baselineMonths, locale),
    });
  });

const merchantConcentration: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    yield* guard(hasPeriod(input), findCorrelationsErrors.missingPeriod(input.analysis));
    const period = resolvePeriod(input);
    const { from, to } = periodRange(period);
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    const rows = await deps.correlations.merchantConcentration(from, to, category?.id ?? null);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.merchant_concentration,
      month: period.month,
      year: period.year,
      categories: shapeMerchantConcentration(rows, input.topN, locale),
    });
  });

const recurringCandidates: AnalysisHandler = (deps, input, locale) =>
  safeTry(async function* () {
    const today = toIsoDate(deps.clock());
    const from = lookbackFrom(today, input.lookbackMonths);
    const rows = await deps.correlations.recurringCandidates(from, today);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.recurring_candidates,
      candidates: shapeRecurringCandidates(rows, input.minOccurrences, locale),
    });
  });

const ANALYSIS_HANDLERS: Record<FindCorrelationsAnalysis, AnalysisHandler> = {
  [FindCorrelationsAnalysis.enum.spending_shifts]: spendingShifts,
  [FindCorrelationsAnalysis.enum.budget_fit]: budgetFit,
  [FindCorrelationsAnalysis.enum.merchant_concentration]: merchantConcentration,
  [FindCorrelationsAnalysis.enum.recurring_candidates]: recurringCandidates,
};

export const findCorrelations = (
  deps: Deps,
  input: ResolvedFindCorrelations,
): ResultAsync<FindCorrelationsResult, AppError> =>
  ResultAsync.fromSafePromise(deps.locale()).andThen((locale) => {
    const handler = ANALYSIS_HANDLERS[input.analysis];
    return handler ? handler(deps, input, locale) : errAsync(findCorrelationsErrors.unhandledAnalysis(input.analysis));
  });
