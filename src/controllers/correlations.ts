import { errAsync, ok, ResultAsync, safeTry } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
import { budgetedCommittedByCurrency } from '../logic/budget.js';
import {
  currentSpendByCurrency,
  merchantSpendByCurrency,
  shapeBudgetFitLines,
  shapeMerchantConcentration,
  shapeRecurringCandidates,
  shapeSpendingShifts,
  shapeUnbudgetedSpend,
} from '../logic/correlations.js';
import { consolidateInCurrency, type CurrencyAmount } from '../logic/currencyRate.js';
import { decimalsLookup } from '../logic/money.js';
import { baselineRange, hasPeriod, lookbackFrom, periodRange, toIsoDate } from '../logic/period.js';
import type { ConvertedTotal } from '../models/currencyRate.js';
import {
  findCorrelationsErrors,
  FindCorrelationsAnalysis,
  type FindCorrelationsResult,
  type ResolvedFindCorrelations,
} from '../models/correlations.js';
import type { Period } from '../models/date.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode, DecimalsFor } from '../models/money.js';
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

/** Converts a mode's own per-currency amounts to `displayCurrency` — correlates a second aggregate
 *  (`currency_rates`), so it's orchestrated here rather than in a repo, mirroring
 *  `getSpendingSummary`/`getBudgetStatus`. */
const convertedTotal = async (
  deps: Deps,
  amounts: readonly CurrencyAmount[],
  displayCurrency: CurrencyCode,
  decimalsFor: DecimalsFor,
): Promise<ConvertedTotal> => {
  const rates = await deps.currencyRates.list();
  const converted = consolidateInCurrency(
    amounts,
    displayCurrency,
    rates,
    deps.clock(),
    deps.rateStaleness,
    decimalsFor(displayCurrency),
  );
  return { displayCurrency, ...converted };
};

type AnalysisHandler = (
  deps: Deps,
  input: ResolvedFindCorrelations,
  locale: Locale,
  decimalsFor: DecimalsFor,
) => ResultAsync<FindCorrelationsResult, AppError>;

const spendingShifts: AnalysisHandler = (deps, input, locale, decimalsFor) =>
  safeTry(async function* () {
    yield* guard(hasPeriod(input), findCorrelationsErrors.missingPeriod(input.analysis));
    const period = resolvePeriod(input);
    const { baselineFrom, currentFrom, currentTo } = resolveWindows(period, input.baselineMonths);
    const rows = await deps.correlations.spendingShifts(baselineFrom, currentFrom, currentTo);
    const shifts = shapeSpendingShifts(rows, input.baselineMonths, input.minDeltaPct, locale, decimalsFor);
    if (!input.displayCurrency) {
      return ok({
        analysis: FindCorrelationsAnalysis.enum.spending_shifts,
        month: period.month,
        year: period.year,
        shifts,
      });
    }
    const converted = await convertedTotal(deps, currentSpendByCurrency(rows), input.displayCurrency, decimalsFor);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.spending_shifts,
      month: period.month,
      year: period.year,
      shifts,
      converted,
    });
  });

const budgetFit: AnalysisHandler = (deps, input, locale, decimalsFor) =>
  safeTry(async function* () {
    yield* guard(hasPeriod(input), findCorrelationsErrors.missingPeriod(input.analysis));
    const period = resolvePeriod(input);
    const { baselineFrom, currentFrom, currentTo } = resolveWindows(period, input.baselineMonths);
    // shiftRows reuses spendingShifts' own query to find unbudgeted candidates, excluding what `budgeted` covers.
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
      decimalsFor,
    );
    const unbudgeted = shapeUnbudgetedSpend(shiftRows, budgeted, input.baselineMonths, locale, decimalsFor);
    if (!input.displayCurrency) {
      return ok({
        analysis: FindCorrelationsAnalysis.enum.budget_fit,
        month: period.month,
        year: period.year,
        budgeted,
        unbudgeted,
      });
    }
    // A fresh committed-spend read (get_budget_status's own measure), not windowedSpend above
    // (current-vs-baseline only) — so the two surfaces' converted totals agree.
    const committedSpend = await deps.transactions.spendByCategory(currentFrom, currentTo);
    const converted = await convertedTotal(
      deps,
      budgetedCommittedByCurrency(budgets, committedSpend),
      input.displayCurrency,
      decimalsFor,
    );
    return ok({
      analysis: FindCorrelationsAnalysis.enum.budget_fit,
      month: period.month,
      year: period.year,
      budgeted,
      unbudgeted,
      converted,
    });
  });

const merchantConcentration: AnalysisHandler = (deps, input, locale, decimalsFor) =>
  safeTry(async function* () {
    yield* guard(hasPeriod(input), findCorrelationsErrors.missingPeriod(input.analysis));
    const period = resolvePeriod(input);
    const { from, to } = periodRange(period);
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    const rows = await deps.correlations.merchantConcentration(from, to, category?.id ?? null);
    const categories = shapeMerchantConcentration(rows, input.topN, locale, decimalsFor);
    if (!input.displayCurrency) {
      return ok({
        analysis: FindCorrelationsAnalysis.enum.merchant_concentration,
        month: period.month,
        year: period.year,
        categories,
      });
    }
    const converted = await convertedTotal(
      deps,
      merchantSpendByCurrency(categories),
      input.displayCurrency,
      decimalsFor,
    );
    return ok({
      analysis: FindCorrelationsAnalysis.enum.merchant_concentration,
      month: period.month,
      year: period.year,
      categories,
      converted,
    });
  });

const recurringCandidates: AnalysisHandler = (deps, input, locale, decimalsFor) =>
  safeTry(async function* () {
    const today = toIsoDate(deps.clock());
    const from = lookbackFrom(today, input.lookbackMonths);
    const rows = await deps.correlations.recurringCandidates(from, today);
    return ok({
      analysis: FindCorrelationsAnalysis.enum.recurring_candidates,
      candidates: shapeRecurringCandidates(rows, input.minOccurrences, locale, decimalsFor),
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
  ResultAsync.fromSafePromise(Promise.all([deps.locale(), deps.currencies.list()])).andThen(([locale, currencies]) => {
    const handler = ANALYSIS_HANDLERS[input.analysis];
    return handler
      ? handler(deps, input, locale, decimalsLookup(currencies))
      : errAsync(findCorrelationsErrors.unhandledAnalysis(input.analysis));
  });
