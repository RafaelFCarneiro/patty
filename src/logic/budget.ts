import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import type { CurrencyAmount } from './currencyRate.js';
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

/** A category-or-sub-category-by-name selection, budget's own minimal shape (unlike transactions'
 *  `CategoryFields`, a target is required — never both unset). */
export type BudgetTargetFields = { category?: string; subCategory?: string };

/** Value-based type predicates (mirrors `logic/transaction.ts`'s `hasCategory`/`hasSubCategory`),
 *  for `resolveBudgetTarget` (`controllers/budgets.ts`) to dispatch on. */
export const hasCategory = (input: BudgetTargetFields): input is BudgetTargetFields & { category: string } =>
  input.category !== undefined;

export const hasSubCategory = (input: BudgetTargetFields): input is BudgetTargetFields & { subCategory: string } =>
  input.subCategory !== undefined;

/** True when exactly one of `category`/`subCategory` was provided — not neither, not both. */
export const hasExactlyOneTarget = (input: BudgetTargetFields): boolean => hasCategory(input) !== hasSubCategory(input);

/** A budget caps spending, so only an expense-eligible category may be targeted — `both`-kind
 *  categories (e.g. "Investments", "Other") are eligible since they can carry expense
 *  transactions; only a pure `income`-kind category is rejected. */
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

/** `parentName!` is safe: a category's `parent_id` is a self-referencing FK `delete_category`
 *  never lets dangle, so the `LEFT JOIN parent` always matches when `nodeParentId` is set. */
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

/** Sorted by the localized category/sub-category — the repo query's own ordering is by raw name,
 *  which can disagree with the localized one. */
export const rowsToViews = (rows: readonly BudgetViewInput[], locale: Locale): BudgetView[] =>
  R.pipe(
    rows,
    R.map((row) => rowToView(row, locale)),
    R.sortBy([(v) => v.category, 'asc'], [(v) => v.subCategory ?? '', 'asc']),
  );

// The minimal shape both CategorySpend and CategoryWindowedSpend satisfy structurally.
type SpendCategoryKey = { categoryId: string; subCategoryId: string | null };

/** A top-level target matches every row sharing its `categoryId` — a sub-category transaction's
 *  `category_id` is always its parent's (invariant 7), so this rolls up sub-category spend for
 *  free; a sub-category target matches only rows sharing its own id as `subCategoryId`. */
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

/** Over-budget is reported as-is — `pct`/`remaining` are never clamped or flagged as an error.
 *  `remaining` is reported against `committed` (effective + pending), the earmark-aware measure;
 *  effective headroom is `limit - effective.amount`. */
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

/** Committed (effective + pending) spend per currency, across every spend row matched by at least
 *  one budget — the amount an opt-in `displayCurrency` grand total converts (Feature Design 021).
 *  A spend row matched by more than one budget line (a sub-category and its rolled-up parent both
 *  budgeted) is summed once here, not once per matching line — `groupStatusByCategory`'s per-line
 *  `committed` intentionally double-counts that row for each line's own reading, which is correct
 *  per-line but would inflate a cross-line total. */
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

/** Correlates each budget to its own spend (ADR-028 moved this out of the repo into pure logic)
 *  and shapes the grouped-by-category response. Per-currency and per-sub-category lines read as
 *  one coherent unit, never summed together (no cross-currency total). Sorted explicitly (mirrors
 *  `logic/summary.ts`'s `summarize` / `logic/aggregate.ts`'s `shapeAggregateResult`) rather than
 *  relying on the repo query's own ordering, so the response is deterministic regardless of row
 *  order in. */
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
