import { z } from 'zod';
import { PeriodSchema } from '../../models/date.js';
import { BudgetStatusGroupSchema } from '../../models/budget.js';
import { ConvertedTotalSchema } from '../../models/currencyRate.js';

export const BudgetStatusOutSchema = z.object({
  period: PeriodSchema,
  categories: z.array(BudgetStatusGroupSchema),
  converted: ConvertedTotalSchema.optional().describe(
    'Opt-in converted grand total of committed (effective + pending) spend across budgeted categories, ' +
      'in every currency — present only when displayCurrency was supplied',
  ),
});
export type BudgetStatusOut = z.infer<typeof BudgetStatusOutSchema>;
