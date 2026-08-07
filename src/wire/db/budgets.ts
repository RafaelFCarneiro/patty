import { z } from 'zod';
import type { budgets } from '../../diplomat/db/schema.js';
import { BudgetPeriod } from '../../models/budget.js';
import { CurrencyCode } from '../../models/money.js';
import { parseCategoryNames } from './categories.js';

// Budget row from a Drizzle select — derived from schema.ts (single source of truth).
export type BudgetRow = typeof budgets.$inferSelect;

/** Shared shape of the budget-with-target self-join row (`diplomat/db/repos/budgets.ts`) — stays a
 *  hand schema like `SubCategoryRowSchema` (`wire/db/categories.ts`) until the raw reads are
 *  unified under drizzle-orm/zod. `node_parent_id` null means the budgeted node is itself a
 *  top-level category; set means it's a sub-category, with `parent_name`/`parent_names`
 *  describing its parent. */
const budgetTargetRowShape = {
  id: z.string(),
  currency: CurrencyCode,
  limit_amount: z.number(),
  period: BudgetPeriod,
  node_name: z.string(),
  node_names: z.string().nullable().default(null),
  node_parent_id: z.string().nullable(),
  parent_name: z.string().nullable(),
  parent_names: z.string().nullable().default(null),
};

const shapeTargetRow = <T extends Record<string, unknown>>({
  limit_amount,
  node_name,
  node_names,
  node_parent_id,
  parent_name,
  parent_names,
  ...rest
}: T & {
  limit_amount: number;
  node_name: string;
  node_names: string | null;
  node_parent_id: string | null;
  parent_name: string | null;
  parent_names: string | null;
}) => ({
  ...rest,
  limit: limit_amount,
  nodeName: node_name,
  nodeNames: parseCategoryNames(node_names),
  nodeParentId: node_parent_id,
  parentName: parent_name,
  parentNames: parseCategoryNames(parent_names),
});

export const BudgetViewRowSchema = z.object({ ...budgetTargetRowShape, version: z.number() }).transform(shapeTargetRow);
export type BudgetViewRow = z.output<typeof BudgetViewRowSchema>;

// Same target-joined shape as `BudgetViewRowSchema`, plus the period's measured spend — no
// `version`, a status read never guards a write.
export const BudgetStatusRowSchema = z.object({ ...budgetTargetRowShape, spent: z.number() }).transform(shapeTargetRow);
export type BudgetStatusRow = z.output<typeof BudgetStatusRowSchema>;
