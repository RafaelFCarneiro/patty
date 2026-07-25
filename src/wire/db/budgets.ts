import { z } from 'zod';
import type { budgets } from '../../diplomat/db/schema.js';

// Budget row from a Drizzle select — derived from schema.ts (single source of truth).
export type BudgetRow = typeof budgets.$inferSelect;

// Budget-with-target-names row from the raw self-join SELECT (diplomat/db/repos/budgets.ts) —
// stays a hand schema like `SubCategoryRowSchema` (wire/db/categories.ts) until the raw reads are
// unified under drizzle-orm/zod. `node_parent_id` null means the budgeted node is itself a
// top-level category; set means it's a sub-category, and `parent_name` is its parent's name.
export const BudgetViewRowSchema = z.object({
  id: z.string(),
  currency: z.string(),
  limit_amount: z.number(),
  period: z.string(),
  version: z.number(),
  node_name: z.string(),
  node_parent_id: z.string().nullable(),
  parent_name: z.string().nullable(),
});
