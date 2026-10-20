import type { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import { CoercedPeriodSchema } from './period.js';

export const SummaryQuerySchema = CoercedPeriodSchema.extend({
  displayCurrency: CurrencyCode.optional().describe(
    'Opt-in: also return a converted grand total of expenses in this currency',
  ),
});
export type SummaryQuery = z.infer<typeof SummaryQuerySchema>;
