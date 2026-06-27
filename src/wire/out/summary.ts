import { z } from 'zod'
import { PeriodSchema } from '../../models/common.js'
import { CurrencySummarySchema } from '../../models/summary.js'

export const SpendingSummaryOut = z.object({
  period: PeriodSchema,
  currencies: z.array(CurrencySummarySchema),
})
export type SpendingSummaryOut = z.infer<typeof SpendingSummaryOut>
