import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import { parseCategoryNames } from './categories.js';

/** `current`/`baseline_total` are raw SUMs — `logic/correlations.ts`'s `toSpendingShift` divides
 *  `baselineTotal` by `baselineMonths` and derives `deltaPct`/`direction` from the pair. */
export const SpendingShiftDbRowSchema = z
  .object({
    category: z.string().min(1),
    category_names: z.string().nullable().default(null),
    currency: CurrencyCode,
    current: z.number(),
    baseline_total: z.number(),
  })
  .transform(({ category_names, baseline_total, ...rest }) => ({
    ...rest,
    categoryNames: parseCategoryNames(category_names),
    baselineTotal: baseline_total,
  }));

export type SpendingShiftDbRow = z.output<typeof SpendingShiftDbRowSchema>;

/** One row per existing budget — `current`/`baseline_total` are the same conditional-SUM split as
 *  `SpendingShiftDbRowSchema`, but matched to the budget's own target (`budgetTargetMatch`,
 *  `diplomat/db/repos/budgets.ts`) rather than a plain category rollup. `node_parent_id` null means
 *  the budgeted node is itself a top-level category; set means it's a sub-category, and
 *  `parent_name`/`parent_names` describe its parent. Mirrors `BudgetStatusRowSchema`
 *  (`wire/db/budgets.ts`) plus the current/baseline split. */
export const BudgetFitDbRowSchema = z
  .object({
    id: z.string().min(1),
    currency: CurrencyCode,
    limit_amount: z.number(),
    node_name: z.string(),
    node_names: z.string().nullable().default(null),
    node_parent_id: z.string().nullable(),
    parent_name: z.string().nullable(),
    parent_names: z.string().nullable().default(null),
    current: z.number(),
    baseline_total: z.number(),
  })
  .transform(({ limit_amount, node_names, parent_names, baseline_total, ...rest }) => ({
    ...rest,
    limit: limit_amount,
    nodeNames: parseCategoryNames(node_names),
    parentNames: parseCategoryNames(parent_names),
    baselineTotal: baseline_total,
  }));

export type BudgetFitDbRow = z.output<typeof BudgetFitDbRowSchema>;
