import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { isSubCategoryRow, matchesTarget, resolveTargetNames } from './budget.js';
import { roundMoney, roundToDecimals } from './money.js';
import { daysBetween } from './period.js';
import { nextDue } from './recurring.js';
import type { BudgetViewInput } from '../models/budget.js';
import {
  BudgetFitVerdict,
  CADENCE_AMOUNT_TOLERANCE_PCT,
  CADENCE_DAY_TOLERANCE_DAYS,
  CADENCE_NOMINAL_GAP_DAYS,
  SpendingShiftDirection,
  SUGGESTED_LIMIT_MARGIN_PCT,
  type BudgetFitLine,
  type CategoryConcentration,
  type MerchantConcentrationInput,
  type MerchantShare,
  type RecurringCandidate,
  type RecurringCandidateInput,
  type SpendingShift,
  type SpendingShiftInput,
  type UnbudgetedSpend,
  type CadenceResult,
} from '../models/correlations.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode, DecimalsFor } from '../models/money.js';
import type { CategoryWindowedSpend } from '../models/transaction.js';
import { RecurringPeriod } from '../models/recurring.js';
import { unknownLabels } from '../models/aggregate.js';
import type { CurrencyAmount } from '../models/currencyRate.js';

const shiftMagnitude = (deltaPct: number | null): number =>
  deltaPct === null ? Number.POSITIVE_INFINITY : Math.abs(deltaPct);

const passesThreshold = (deltaPct: number | null, minDeltaPct: number): boolean =>
  deltaPct === null || Math.abs(deltaPct) >= minDeltaPct;

const toSpendingShift = (
  row: SpendingShiftInput,
  baselineMonths: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): SpendingShift => {
  const rawBaseline = row.baselineTotal / baselineMonths;
  const deltaPct = rawBaseline === 0 ? null : roundMoney(((row.current - rawBaseline) / rawBaseline) * 100);
  const direction =
    deltaPct === null || row.current >= rawBaseline ? SpendingShiftDirection.enum.up : SpendingShiftDirection.enum.down;
  const decimals = decimalsFor(row.currency);
  return {
    category: localizeCategoryName(row.category, row.categoryNames, locale) ?? row.category,
    currency: row.currency,
    current: roundToDecimals(row.current, decimals),
    baseline: roundToDecimals(rawBaseline, decimals),
    deltaPct,
    direction,
  };
};

export const shapeSpendingShifts = (
  rows: readonly SpendingShiftInput[],
  baselineMonths: number,
  minDeltaPct: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): SpendingShift[] =>
  R.pipe(
    rows,
    R.map((row) => toSpendingShift(row, baselineMonths, locale, decimalsFor)),
    R.filter((shift) => passesThreshold(shift.deltaPct, minDeltaPct)),
    R.sortBy([(shift) => shiftMagnitude(shift.deltaPct), 'desc']),
  );

export const currentSpendByCurrency = (rows: readonly SpendingShiftInput[]): CurrencyAmount[] =>
  R.pipe(
    rows,
    R.groupBy((row) => row.currency),
    R.entries(),
    R.map(([currency, group]): CurrencyAmount => ({
      currency: currency as CurrencyCode,
      amount: R.sumBy(group, (row) => row.current),
    })),
  );

const suggestedLimitFor = (baseline: number, decimals: number): number =>
  roundToDecimals(baseline * (1 + SUGGESTED_LIMIT_MARGIN_PCT / 100), decimals);

const verdictFor = (baseline: number, limit: number, slackPct: number, overPct: number): BudgetFitVerdict => {
  const ratio = baseline / limit;
  if (ratio > 1 + overPct / 100) return BudgetFitVerdict.enum.unrealistic;
  if (ratio < 1 - slackPct / 100) return BudgetFitVerdict.enum.generous;
  return BudgetFitVerdict.enum.realistic;
};

const sumWindowedSpend = (
  spend: readonly CategoryWindowedSpend[],
  budget: BudgetViewInput,
): { current: number; baselineTotal: number } => {
  const isSubCategory = isSubCategoryRow(budget);
  const matched = R.filter(
    spend,
    (s) => s.currency === budget.currency && matchesTarget(s, isSubCategory, budget.targetId),
  );
  return { current: R.sumBy(matched, (s) => s.current), baselineTotal: R.sumBy(matched, (s) => s.baselineTotal) };
};

const toBudgetFitLine = (
  budget: BudgetViewInput,
  spend: readonly CategoryWindowedSpend[],
  baselineMonths: number,
  slackPct: number,
  overPct: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): BudgetFitLine => {
  const matched = sumWindowedSpend(spend, budget);
  const rawBaseline = matched.baselineTotal / baselineMonths;
  const decimals = decimalsFor(budget.currency);
  return {
    id: budget.id,
    ...resolveTargetNames(budget, locale),
    currency: budget.currency,
    limit: budget.limit,
    current: roundToDecimals(matched.current, decimals),
    baseline: roundToDecimals(rawBaseline, decimals),
    verdict: verdictFor(rawBaseline, budget.limit, slackPct, overPct),
    suggestedLimit: suggestedLimitFor(rawBaseline, decimals),
  };
};

export const shapeBudgetFitLines = (
  budgets: readonly BudgetViewInput[],
  spend: readonly CategoryWindowedSpend[],
  baselineMonths: number,
  slackPct: number,
  overPct: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): BudgetFitLine[] =>
  R.pipe(
    budgets,
    R.map((budget) => toBudgetFitLine(budget, spend, baselineMonths, slackPct, overPct, locale, decimalsFor)),
    R.sortBy(
      [(line) => line.category, 'asc'],
      [(line) => line.currency, 'asc'],
      [(line) => line.subCategory ?? '', 'asc'],
    ),
  );

const categoryCurrencyKey = (category: string, currency: CurrencyCode): string => JSON.stringify([category, currency]);

export const shapeUnbudgetedSpend = (
  shiftRows: readonly SpendingShiftInput[],
  budgeted: readonly BudgetFitLine[],
  baselineMonths: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): UnbudgetedSpend[] => {
  const budgetedKeys = new Set(budgeted.map((line) => categoryCurrencyKey(line.category, line.currency)));
  return R.pipe(
    shiftRows,
    R.map((row) => ({
      category: localizeCategoryName(row.category, row.categoryNames, locale) ?? row.category,
      currency: row.currency,
      rawBaseline: row.baselineTotal / baselineMonths,
    })),
    R.filter(
      (shift) => shift.rawBaseline > 0 && !budgetedKeys.has(categoryCurrencyKey(shift.category, shift.currency)),
    ),
    R.map((shift): UnbudgetedSpend => {
      const decimals = decimalsFor(shift.currency);
      return {
        category: shift.category,
        currency: shift.currency,
        baseline: roundToDecimals(shift.rawBaseline, decimals),
        suggestedLimit: suggestedLimitFor(shift.rawBaseline, decimals),
      };
    }),
    R.sortBy([(entry) => entry.category, 'asc'], [(entry) => entry.currency, 'asc']),
  );
};

const roundShare = (value: number): number => Math.round(value * 10000) / 10000;

const resolveMerchantLabel = (merchantKey: string | null, locale: Locale): string =>
  merchantKey ?? unknownLabels[locale];

const toMerchantShares = (
  top: readonly MerchantConcentrationInput[],
  categoryTotal: number,
  locale: Locale,
  decimals: number,
): MerchantShare[] => {
  const shares = top.map((row) => (categoryTotal === 0 ? 0 : row.spent / categoryTotal));
  return top.map((row, index): MerchantShare => {
    const share = shares[index]!;
    const cumulative = shares.slice(0, index + 1).reduce((total, each) => total + each, 0);
    return {
      merchant: resolveMerchantLabel(row.merchantKey, locale),
      spent: roundToDecimals(row.spent, decimals),
      share: roundShare(share),
      cumulativeShare: roundShare(cumulative),
    };
  });
};

const toCategoryConcentration = (
  rows: readonly MerchantConcentrationInput[],
  topN: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): CategoryConcentration => {
  const { category, categoryNames, currency } = rows[0]!;
  const decimals = decimalsFor(currency);
  const categoryTotal = R.sumBy(rows, (row) => row.spent);
  const top = R.take(R.sortBy(rows, [(row) => row.spent, 'desc']), topN);
  return {
    category: localizeCategoryName(category, categoryNames, locale) ?? category,
    currency,
    categoryTotal: roundToDecimals(categoryTotal, decimals),
    merchants: toMerchantShares(top, categoryTotal, locale, decimals),
    othersSpent: roundToDecimals(categoryTotal - R.sumBy(top, (row) => row.spent), decimals),
  };
};

export const shapeMerchantConcentration = (
  rows: readonly MerchantConcentrationInput[],
  topN: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): CategoryConcentration[] =>
  R.pipe(
    rows,
    R.groupBy((row) => categoryCurrencyKey(row.category, row.currency)),
    R.values(),
    R.map((groupRows) => toCategoryConcentration(groupRows, topN, locale, decimalsFor)),
    R.sortBy([(entry) => entry.category, 'asc'], [(entry) => entry.currency, 'asc']),
  );

export const merchantSpendByCurrency = (
  groups: readonly Pick<CategoryConcentration, 'currency' | 'categoryTotal'>[],
): CurrencyAmount[] =>
  R.pipe(
    groups,
    R.groupBy((group) => group.currency),
    R.entries(),
    R.map(([currency, group]): CurrencyAmount => ({
      currency: currency as CurrencyCode,
      amount: R.sumBy(group, (g) => g.categoryTotal),
    })),
  );

const merchantCurrencyKey = (merchantKey: string, currency: CurrencyCode): string =>
  JSON.stringify([merchantKey, currency]);

const withinTolerance = (value: number, target: number, tolerance: number): boolean =>
  Math.abs(value - target) <= tolerance;

export const detectRecurringCadence = (
  series: readonly { date: string; amount: number }[],
  minOccurrences: number,
  decimals: number,
): CadenceResult | null => {
  const sorted = R.sortBy(series, [(point) => point.date, 'asc']);
  if (sorted.length < minOccurrences) return null;

  const gaps = R.zipWith(sorted, sorted.slice(1), (a, b) => daysBetween(a.date, b.date));
  const isConsistentCadence = gaps.every((gap) =>
    withinTolerance(gap, CADENCE_NOMINAL_GAP_DAYS, CADENCE_DAY_TOLERANCE_DAYS),
  );
  if (!isConsistentCadence) return null;

  const typicalAmount = R.meanBy(sorted, (point) => point.amount);
  const amountTolerance = typicalAmount * (CADENCE_AMOUNT_TOLERANCE_PCT / 100);
  const isStableAmount = sorted.every((point) => withinTolerance(point.amount, typicalAmount, amountTolerance));
  if (!isStableAmount) return null;

  const lastDate = sorted[sorted.length - 1]!.date;
  return {
    typicalAmount: roundToDecimals(typicalAmount, decimals),
    occurrences: sorted.length,
    lastDate,
    suggestedNextDue: nextDue(lastDate, RecurringPeriod.enum.monthly),
  };
};

const toRecurringCandidate = (
  rows: readonly RecurringCandidateInput[],
  minOccurrences: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): RecurringCandidate | null => {
  const { merchantKey, currency } = rows[0]!;
  const cadence = detectRecurringCadence(rows, minOccurrences, decimalsFor(currency));
  if (!cadence) return null;
  const latest = R.firstBy(rows, [(row) => row.date, 'desc'])!;
  return {
    merchant: merchantKey,
    currency,
    category: localizeCategoryName(latest.category, latest.categoryNames, locale) ?? latest.category,
    ...cadence,
  };
};

export const shapeRecurringCandidates = (
  rows: readonly RecurringCandidateInput[],
  minOccurrences: number,
  locale: Locale,
  decimalsFor: DecimalsFor,
): RecurringCandidate[] =>
  R.pipe(
    rows,
    R.groupBy((row) => merchantCurrencyKey(row.merchantKey, row.currency)),
    R.values(),
    R.map((groupRows) => toRecurringCandidate(groupRows, minOccurrences, locale, decimalsFor)),
    R.filter(R.isNonNull),
    R.sortBy([(candidate) => candidate.occurrences, 'desc'], [(candidate) => candidate.merchant, 'asc']),
  );
