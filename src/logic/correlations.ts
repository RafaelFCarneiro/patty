import * as R from 'remeda';
import { unknownLabels } from './aggregate.js';
import { localizeCategoryName } from './category.js';
import { isSubCategoryRow, matchesTarget, resolveTargetNames } from './budget.js';
import { roundMoney } from './money.js';
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
} from '../models/correlations.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';
import type { CategoryWindowedSpend } from '../models/transaction.js';
import { RecurringPeriod } from '../models/recurring.js';

/** A shift with no measurable baseline (brand-new spend) has no percentage to compare against
 *  `minDeltaPct`, but is always the most notable kind of shift — sorts as maximally significant. */
const shiftMagnitude = (deltaPct: number | null): number =>
  deltaPct === null ? Number.POSITIVE_INFINITY : Math.abs(deltaPct);

const passesThreshold = (deltaPct: number | null, minDeltaPct: number): boolean =>
  deltaPct === null || Math.abs(deltaPct) >= minDeltaPct;

const toSpendingShift = (row: SpendingShiftInput, baselineMonths: number, locale: Locale): SpendingShift => {
  // Decide null/direction/deltaPct off the unrounded baseline — rounding first could turn a real
  // (if tiny) baseline into a false 0.00, misclassifying it as brand-new.
  const rawBaseline = row.baselineTotal / baselineMonths;
  const deltaPct = rawBaseline === 0 ? null : roundMoney(((row.current - rawBaseline) / rawBaseline) * 100);
  const direction =
    deltaPct === null || row.current >= rawBaseline
      ? SpendingShiftDirection.enum.up
      : SpendingShiftDirection.enum.down;
  return {
    category: localizeCategoryName(row.category, row.categoryNames, locale) ?? row.category,
    currency: row.currency,
    current: roundMoney(row.current),
    baseline: roundMoney(rawBaseline),
    deltaPct,
    direction,
  };
};

export const shapeSpendingShifts = (
  rows: readonly SpendingShiftInput[],
  baselineMonths: number,
  minDeltaPct: number,
  locale: Locale,
): SpendingShift[] =>
  R.pipe(
    rows,
    R.map((row) => toSpendingShift(row, baselineMonths, locale)),
    R.filter((shift) => passesThreshold(shift.deltaPct, minDeltaPct)),
    R.sortBy([(shift) => shiftMagnitude(shift.deltaPct), 'desc']),
  );

const suggestedLimitFor = (baseline: number): number => roundMoney(baseline * (1 + SUGGESTED_LIMIT_MARGIN_PCT / 100));

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
): BudgetFitLine => {
  const matched = sumWindowedSpend(spend, budget);
  const rawBaseline = matched.baselineTotal / baselineMonths;
  return {
    id: budget.id,
    ...resolveTargetNames(budget, locale),
    currency: budget.currency,
    limit: budget.limit,
    current: roundMoney(matched.current),
    baseline: roundMoney(rawBaseline),
    verdict: verdictFor(rawBaseline, budget.limit, slackPct, overPct),
    suggestedLimit: suggestedLimitFor(rawBaseline),
  };
};

export const shapeBudgetFitLines = (
  budgets: readonly BudgetViewInput[],
  spend: readonly CategoryWindowedSpend[],
  baselineMonths: number,
  slackPct: number,
  overPct: number,
  locale: Locale,
): BudgetFitLine[] =>
  R.pipe(
    budgets,
    R.map((budget) => toBudgetFitLine(budget, spend, baselineMonths, slackPct, overPct, locale)),
    R.sortBy([(line) => line.category, 'asc'], [(line) => line.currency, 'asc'], [(line) => line.subCategory ?? '', 'asc']),
  );

/** Composite grouping key for a (category, currency) pair — JSON-encoded rather than
 *  template-literal-concatenated, so a category name containing the delimiter can never collide
 *  with a differently-split pair. Shared by `shapeUnbudgetedSpend`'s exclusion set and
 *  `shapeMerchantConcentration`'s grouping. */
const categoryCurrencyKey = (category: string, currency: CurrencyCode): string => JSON.stringify([category, currency]);

/** Unbudgeted requires `baseline > 0` — an established spend pattern, not just a one-off
 *  current-month blip. `budgeted` lines already resolve a sub-category budget's `category` to its
 *  parent, so this exclusion covers the parent too. */
export const shapeUnbudgetedSpend = (
  shiftRows: readonly SpendingShiftInput[],
  budgeted: readonly BudgetFitLine[],
  baselineMonths: number,
  locale: Locale,
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
    R.map(
      (shift): UnbudgetedSpend => ({
        category: shift.category,
        currency: shift.currency,
        baseline: roundMoney(shift.rawBaseline),
        suggestedLimit: suggestedLimitFor(shift.rawBaseline),
      }),
    ),
    R.sortBy([(entry) => entry.category, 'asc'], [(entry) => entry.currency, 'asc']),
  );
};

// Share/cumulativeShare are 0-1 fractions — 4 decimals gives ~0.01-percentage-point precision,
// finer than roundMoney's 2 decimals (built for money amounts, not ratios).
const roundShare = (value: number): number => Math.round(value * 10000) / 10000;

const resolveMerchantLabel = (merchantKey: string | null, locale: Locale): string =>
  merchantKey ?? unknownLabels[locale];

/** Accumulates `cumulativeShare` over the unrounded shares (rounding only the returned values),
 *  so the running total stays accurate regardless of how many merchants are returned. Expects
 *  `top` already sorted by spend descending. */
const toMerchantShares = (
  top: readonly MerchantConcentrationInput[],
  categoryTotal: number,
  locale: Locale,
): MerchantShare[] => {
  let cumulative = 0;
  return top.map((row): MerchantShare => {
    const share = categoryTotal === 0 ? 0 : row.spent / categoryTotal;
    cumulative += share;
    return {
      merchant: resolveMerchantLabel(row.merchantKey, locale),
      spent: roundMoney(row.spent),
      share: roundShare(share),
      cumulativeShare: roundShare(cumulative),
    };
  });
};

const toCategoryConcentration = (
  rows: readonly MerchantConcentrationInput[],
  topN: number,
  locale: Locale,
): CategoryConcentration => {
  // Safe: a group from R.groupBy is never empty — every row shares the same category/currency.
  const { category, categoryNames, currency } = rows[0]!;
  const categoryTotal = R.sumBy(rows, (row) => row.spent);
  const top = R.take(R.sortBy(rows, [(row) => row.spent, 'desc']), topN);
  return {
    category: localizeCategoryName(category, categoryNames, locale) ?? category,
    currency,
    categoryTotal: roundMoney(categoryTotal),
    merchants: toMerchantShares(top, categoryTotal, locale),
    othersSpent: roundMoney(categoryTotal - R.sumBy(top, (row) => row.spent)),
  };
};

export const shapeMerchantConcentration = (
  rows: readonly MerchantConcentrationInput[],
  topN: number,
  locale: Locale,
): CategoryConcentration[] =>
  R.pipe(
    rows,
    R.groupBy((row) => categoryCurrencyKey(row.category, row.currency)),
    R.values(),
    R.map((groupRows) => toCategoryConcentration(groupRows, topN, locale)),
    R.sortBy([(entry) => entry.category, 'asc'], [(entry) => entry.currency, 'asc']),
  );

/** Composite grouping key for a (merchant, currency) pair — same JSON-encoding rationale as
 *  `categoryCurrencyKey`. */
const merchantCurrencyKey = (merchantKey: string, currency: CurrencyCode): string =>
  JSON.stringify([merchantKey, currency]);

const withinTolerance = (value: number, target: number, tolerance: number): boolean =>
  Math.abs(value - target) <= tolerance;

type CadenceResult = {
  typicalAmount: number;
  occurrences: number;
  lastDate: string;
  suggestedNextDue: string;
};

export const detectRecurringCadence = (
  series: readonly { date: string; amount: number }[],
  minOccurrences: number,
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
    typicalAmount: roundMoney(typicalAmount),
    occurrences: sorted.length,
    lastDate,
    suggestedNextDue: nextDue(lastDate, RecurringPeriod.enum.monthly),
  };
};

const toRecurringCandidate = (
  rows: readonly RecurringCandidateInput[],
  minOccurrences: number,
  locale: Locale,
): RecurringCandidate | null => {
  const cadence = detectRecurringCadence(rows, minOccurrences);
  if (!cadence) return null;
  const { merchantKey, currency } = rows[0]!;
  // A merchant's category is stable in practice — no need for a full mode-count over the series.
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
): RecurringCandidate[] =>
  R.pipe(
    rows,
    R.groupBy((row) => merchantCurrencyKey(row.merchantKey, row.currency)),
    R.values(),
    R.map((groupRows) => toRecurringCandidate(groupRows, minOccurrences, locale)),
    R.filter(R.isNonNull),
    R.sortBy([(candidate) => candidate.occurrences, 'desc'], [(candidate) => candidate.merchant, 'asc']),
  );
