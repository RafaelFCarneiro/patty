import * as R from 'remeda';
import { unknownLabels } from './aggregate.js';
import { localizeCategoryName } from './category.js';
import { roundMoney } from './money.js';
import {
  BudgetFitVerdict,
  SpendingShiftDirection,
  SUGGESTED_LIMIT_MARGIN_PCT,
  type BudgetFitInput,
  type BudgetFitLine,
  type CategoryConcentration,
  type MerchantConcentrationInput,
  type MerchantShare,
  type SpendingShift,
  type SpendingShiftInput,
  type UnbudgetedSpend,
} from '../models/correlations.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';

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

/** A budget targets either the node itself or one of its sub-categories — mirrors
 *  `adapters/budgets.ts`'s `dbToView`/`dbToStatusEntry`. `parentName!` is safe: a category's
 *  `parent_id` is a self-referencing FK `delete_category` never lets dangle, so the `LEFT JOIN
 *  parent` always matches when `nodeParentId` is set. */
const resolveBudgetTargetNames = (row: BudgetFitInput, locale: Locale): { category: string; subCategory?: string } => {
  const isSubCategory = row.nodeParentId !== null;
  const nodeName = localizeCategoryName(row.nodeName, row.nodeNames, locale) ?? row.nodeName;
  return {
    category: isSubCategory
      ? (localizeCategoryName(row.parentName, row.parentNames, locale) ?? row.parentName!)
      : nodeName,
    subCategory: isSubCategory ? nodeName : undefined,
  };
};

const toBudgetFitLine = (
  row: BudgetFitInput,
  baselineMonths: number,
  slackPct: number,
  overPct: number,
  locale: Locale,
): BudgetFitLine => {
  const rawBaseline = row.baselineTotal / baselineMonths;
  return {
    id: row.id,
    ...resolveBudgetTargetNames(row, locale),
    currency: row.currency,
    limit: row.limit,
    current: roundMoney(row.current),
    baseline: roundMoney(rawBaseline),
    verdict: verdictFor(rawBaseline, row.limit, slackPct, overPct),
    suggestedLimit: suggestedLimitFor(rawBaseline),
  };
};

export const shapeBudgetFitLines = (
  rows: readonly BudgetFitInput[],
  baselineMonths: number,
  slackPct: number,
  overPct: number,
  locale: Locale,
): BudgetFitLine[] =>
  R.pipe(
    rows,
    R.map((row) => toBudgetFitLine(row, baselineMonths, slackPct, overPct, locale)),
    R.sortBy((line) => line.category),
  );

const budgetedKey = (category: string, currency: CurrencyCode): string => `${category}::${currency}`;

/** Unbudgeted requires `baseline > 0` — an established spend pattern, not just a one-off
 *  current-month blip. `budgeted` lines already resolve a sub-category budget's `category` to its
 *  parent, so this exclusion covers the parent too. */
export const shapeUnbudgetedSpend = (
  shiftRows: readonly SpendingShiftInput[],
  budgeted: readonly BudgetFitLine[],
  baselineMonths: number,
  locale: Locale,
): UnbudgetedSpend[] => {
  const budgetedKeys = new Set(budgeted.map((line) => budgetedKey(line.category, line.currency)));
  return R.pipe(
    shiftRows,
    R.map((row) => ({
      category: localizeCategoryName(row.category, row.categoryNames, locale) ?? row.category,
      currency: row.currency,
      rawBaseline: row.baselineTotal / baselineMonths,
    })),
    R.filter((shift) => shift.rawBaseline > 0 && !budgetedKeys.has(budgetedKey(shift.category, shift.currency))),
    R.map(
      (shift): UnbudgetedSpend => ({
        category: shift.category,
        currency: shift.currency,
        baseline: roundMoney(shift.rawBaseline),
        suggestedLimit: suggestedLimitFor(shift.rawBaseline),
      }),
    ),
    R.sortBy((entry) => entry.category),
  );
};

// Share/cumulativeShare are 0-1 fractions — 4 decimals gives ~0.01-percentage-point precision,
// finer than roundMoney's 2 decimals (built for money amounts, not ratios).
const roundShare = (value: number): number => Math.round(value * 10000) / 10000;

const resolveMerchantLabel = (merchantKey: string | null, locale: Locale): string =>
  merchantKey ?? unknownLabels[locale];

const categoryCurrencyKey = (category: string, currency: CurrencyCode): string => `${category}::${currency}`;

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
    R.sortBy((entry) => entry.category),
  );
