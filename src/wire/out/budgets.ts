import { z } from 'zod';
import { PeriodSchema } from '../../models/date.js';
import { BudgetStatusGroupSchema } from '../../models/budget.js';

export const BudgetStatusOutSchema = z.object({
  period: PeriodSchema,
  categories: z.array(BudgetStatusGroupSchema),
});
export type BudgetStatusOut = z.infer<typeof BudgetStatusOutSchema>;
