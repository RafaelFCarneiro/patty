import { z } from 'zod';
import { PeriodSchema } from '../../models/date.js';
import { ConvertedTotalSchema } from '../../models/currency-rate.js';
import { CurrencySummarySchema } from '../../models/summary.js';

export const SpendingSummaryOut = z.object({
  period: PeriodSchema,
  currencies: z.array(CurrencySummarySchema),
  converted: ConvertedTotalSchema.optional().describe(
    'Opt-in converted grand total of expenses across currencies — present only when displayCurrency was supplied',
  ),
});
export type SpendingSummaryOut = z.infer<typeof SpendingSummaryOut>;
