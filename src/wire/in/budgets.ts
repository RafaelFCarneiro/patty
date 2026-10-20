import type { z } from 'zod';
import * as modelBudget from '../../models/budget.js';
import { CurrencyCode } from '../../models/money.js';
import { CoercedPeriodSchema } from './period.js';

// The boundary owns the quality-of-life default; the domain keeps `period` required (not-null).
export const CreateBudgetSchema = modelBudget.CreateBudgetSchema.extend({
  period: modelBudget.CreateBudgetSchema.shape.period.default(modelBudget.BudgetPeriod.enum.monthly),
});
export type CreateBudget = z.infer<typeof CreateBudgetSchema>;

export const UpdateBudgetSchema = modelBudget.UpdateBudgetSchema;
export type UpdateBudget = z.infer<typeof UpdateBudgetSchema>;

export const BudgetStatusQuerySchema = CoercedPeriodSchema.extend({
  displayCurrency: CurrencyCode.optional().describe(
    'Opt-in: also return a converted grand total of committed spend in this currency',
  ),
});
export type BudgetStatusQuery = z.infer<typeof BudgetStatusQuerySchema>;
