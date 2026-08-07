import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { CategoryKind } from '../models/category.js';
import type {
  Budget,
  BudgetMeasure,
  BudgetStatusEntry,
  BudgetStatusGroup,
  BudgetStatusInput,
  BudgetStatusLine,
  BudgetTarget,
  BudgetTargetRow,
  BudgetView,
  BudgetViewInput,
} from '../models/budget.js';
import type { Locale } from '../models/locale.js';

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

/** `parentName!` is safe: a category's `parent_id` is a self-referencing FK `delete_category`
 *  never lets dangle, so the `LEFT JOIN parent` always matches when `nodeParentId` is set. */
const resolveTargetNames = (row: BudgetTargetRow, locale: Locale): { category: string; subCategory?: string } => {
  const isSubCategory = row.nodeParentId !== null;
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

const rowToStatusEntry = (row: BudgetStatusInput, locale: Locale): BudgetStatusEntry => ({
  id: row.id,
  currency: row.currency,
  limit: row.limit,
  period: row.period,
  spentEffective: row.spentEffective,
  spentPending: row.spentPending,
  ...resolveTargetNames(row, locale),
});

const toMeasure = (amount: number, limit: number): BudgetMeasure => ({ amount, pct: amount / limit });

/** Over-budget is reported as-is — `pct`/`remaining` are never clamped or flagged as an error.
 *  `committed` (effective + pending) is the earmark-aware measure `remaining` is reported against
 *  (FD-020); effective headroom is trivially `limit - effective.amount` for a caller that wants it. */
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

/** Per-currency and per-sub-category lines read as one coherent unit, never summed together (no
 *  cross-currency total). Sorted explicitly (mirrors `logic/summary.ts`'s `summarize` /
 *  `logic/aggregate.ts`'s `shapeAggregateResult`) rather than relying on the repo query's own
 *  ordering, so the response is deterministic regardless of row order in. */
export const groupStatusByCategory = (rows: readonly BudgetStatusInput[], locale: Locale): BudgetStatusGroup[] =>
  R.pipe(
    rows,
    R.map((row) => rowToStatusEntry(row, locale)),
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
