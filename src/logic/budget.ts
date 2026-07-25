import { CategoryKind } from '../models/category.js';

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
