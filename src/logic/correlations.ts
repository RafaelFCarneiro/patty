import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { roundMoney } from './money.js';
import {
  BudgetFitVerdict,
  SpendingShiftDirection,
  SUGGESTED_LIMIT_MARGIN_PCT,
  type BudgetFitLine,
  type SpendingShift,
  type UnbudgetedSpend,
} from '../models/correlations.js';
import type { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';
import type { BudgetFitDbRow, SpendingShiftDbRow } from '../wire/db/correlations.js';

/** A shift with no measurable baseline (brand-new spend) has no percentage to compare against
 *  `minDeltaPct`, but is always the most notable kind of shift — sorts as maximally significant. */
const shiftMagnitude = (deltaPct: number | null): number =>
  deltaPct === null ? Number.POSITIVE_INFINITY : Math.abs(deltaPct);

const passesThreshold = (deltaPct: number | null, minDeltaPct: number): boolean =>
  deltaPct === null || Math.abs(deltaPct) >= minDeltaPct;

const toSpendingShift = (row: SpendingShiftDbRow, baselineMonths: number, locale: Locale): SpendingShift => {
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
  rows: readonly SpendingShiftDbRow[],
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

/** A budget's target is either the node itself (`node_parent_id` null — a top-level category) or a
 *  sub-category of it — mirrors `adapters/budgets.ts`'s `dbToView`/`dbToStatusEntry`. `parent_name!`
 *  is safe: `isSubCategory` true means `node.parent_id` is set, and a category's `parent_id` is a
 *  self-referencing FK that can never point at a deleted row (`delete_category` blocks deleting a
 *  category any sub-category still references), so the `LEFT JOIN parent` always matches here. */
const resolveBudgetTargetNames = (
  row: BudgetFitDbRow,
  locale: Locale,
): { category: string; subCategory?: string } => {
  const isSubCategory = row.node_parent_id !== null;
  const nodeName = localizeCategoryName(row.node_name, row.nodeNames, locale) ?? row.node_name;
  return {
    category: isSubCategory
      ? (localizeCategoryName(row.parent_name, row.parentNames, locale) ?? row.parent_name!)
      : nodeName,
    subCategory: isSubCategory ? nodeName : undefined,
  };
};

const toBudgetFitLine = (
  row: BudgetFitDbRow,
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
  rows: readonly BudgetFitDbRow[],
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

/** A category counts as "unbudgeted" when it has an established (nonzero) baseline spend pattern
 *  and no budget at all covers it — a one-off current-month blip with no track record isn't a
 *  suggestion-worthy pattern yet. `budgeted` is the same-request `shapeBudgetFitLines` result, so a
 *  sub-category budget's line (whose `category` is already resolved to its parent) still excludes
 *  the parent category from this list. */
export const shapeUnbudgetedSpend = (
  shiftRows: readonly SpendingShiftDbRow[],
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
