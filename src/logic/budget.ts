import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { CategoryKind } from '../models/category.js';
import type {
  Budget,
  BudgetMeasure,
  BudgetStatusEntry,
  BudgetStatusGroup,
  BudgetStatusLine,
  BudgetTarget,
  BudgetTargetRow,
  BudgetView,
  BudgetViewInput,
} from '../models/budget.js';
import type { CurrencyCode } from '../models/money.js';
import type { Locale } from '../models/locale.js';
import type { CategorySpend } from '../models/transaction.js';
import { CurrencyAmount } from '../models/currencyRate.js';
import { BudgetTargetFields, SpendCategoryKey } from '../models/budget.js';

export const hasCategory = (input: BudgetTargetFields): input is BudgetTargetFields & { category: string } =>
  input.category !== undefined;

export const hasSubCategory = (input: BudgetTargetFields): input is BudgetTargetFields & { subCategory: string } =>
  input.subCategory !== undefined;

export const hasExactlyOneTarget = (input: BudgetTargetFields): boolean => hasCategory(input) !== hasSubCategory(input);

export const isExpenseEligible = (kind: CategoryKind): boolean => kind !== CategoryKind.enum.income;

export const toView = (
  budget: Pick<Budget, 'id' | 'currency' | 'limit' | 'period'>,
  target: Pick<BudgetTarget, 'category' | 'subCategory'>,
): BudgetView => ({
  id: budget.id,
  currency: budget.currency,
  limit: budget.limit,
  period: budget.period,
  category: target.category,
  subCategory: target.subCategory,
});

export const isSubCategoryRow = (row: BudgetTargetRow): boolean => row.nodeParentId !== null;

export const resolveTargetNames = (
  row: BudgetTargetRow,
  locale: Locale,
): { category: string; subCategory?: string } => {
  const isSubCategory = isSubCategoryRow(row);
  const nodeName = localizeCategoryName(row.nodeName, row.nodeNames, locale) ?? row.nodeName;
  return {
    category: isSubCategory
      ? (localizeCategoryName(row.parentName, row.parentNames, locale) ?? row.parentName!)
      : nodeName,
    subCategory: isSubCategory ? nodeName : undefined,
  };
};

export const rowToView = (row: BudgetViewInput, locale: Locale): BudgetView => ({
  id: row.id,
  currency: row.currency,
  limit: row.limit,
  period: row.period,
  ...resolveTargetNames(row, locale),
});

export const rowsToViews = (rows: readonly BudgetViewInput[], locale: Locale): BudgetView[] =>
  R.pipe(
    rows,
    R.map((row) => rowToView(row, locale)),
    R.sortBy([(v) => v.category, 'asc'], [(v) => v.subCategory ?? '', 'asc']),
  );

export const matchesTarget = (spend: SpendCategoryKey, isSubCategory: boolean, targetId: string): boolean =>
  isSubCategory ? spend.subCategoryId === targetId : spend.categoryId === targetId;

const sumMatchedSpend = (
  spend: readonly CategorySpend[],
  row: BudgetViewInput,
): { effective: number; pending: number } => {
  const isSubCategory = isSubCategoryRow(row);
  const matched = R.filter(
    spend,
    (s) => s.currency === row.currency && matchesTarget(s, isSubCategory, row.targetId),
  );
  return { effective: R.sumBy(matched, (s) => s.effective), pending: R.sumBy(matched, (s) => s.pending) };
};

const rowToStatusEntry = (row: BudgetViewInput, spend: readonly CategorySpend[], locale: Locale): BudgetStatusEntry => {
  const matched = sumMatchedSpend(spend, row);
  return {
    id: row.id,
    currency: row.currency,
    limit: row.limit,
    period: row.period,
    spentEffective: matched.effective,
    spentPending: matched.pending,
    ...resolveTargetNames(row, locale),
  };
};

const toMeasure = (amount: number, limit: number): BudgetMeasure => ({ amount, pct: amount / limit });

const toStatusLine = (entry: BudgetStatusEntry): BudgetStatusLine => {
  const committedAmount = entry.spentEffective + entry.spentPending;
  return {
    id: entry.id,
    currency: entry.currency,
    limit: entry.limit,
    period: entry.period,
    subCategory: entry.subCategory,
    effective: toMeasure(entry.spentEffective, entry.limit),
    committed: toMeasure(committedAmount, entry.limit),
    pending: toMeasure(entry.spentPending, entry.limit),
    remaining: entry.limit - committedAmount,
  };
};

export const budgetedCommittedByCurrency = (
  budgets: readonly BudgetViewInput[],
  spend: readonly CategorySpend[],
): CurrencyAmount[] =>
  R.pipe(
    spend,
    R.filter((s) =>
      budgets.some((b) => b.currency === s.currency && matchesTarget(s, isSubCategoryRow(b), b.targetId)),
    ),
    R.groupBy((s) => s.currency),
    R.entries(),
    R.map(([currency, rows]): CurrencyAmount => ({
      currency: currency as CurrencyCode,
      amount: R.sumBy(rows, (s) => s.effective + s.pending),
    })),
  );

export const groupStatusByCategory = (
  budgets: readonly BudgetViewInput[],
  spend: readonly CategorySpend[],
  locale: Locale,
): BudgetStatusGroup[] =>
  R.pipe(
    budgets,
    R.map((row) => rowToStatusEntry(row, spend, locale)),
    R.groupBy((e) => e.category),
    R.entries(),
    R.map(([category, categoryEntries]): BudgetStatusGroup => {
      const lines: BudgetStatusLine[] = R.map(categoryEntries, toStatusLine);
      return {
        category,
        lines: R.sortBy(lines, [(l) => l.subCategory ?? '', 'asc'], [(l) => l.currency, 'asc']),
      };
    }),
    R.sortBy((group) => group.category),
  );
