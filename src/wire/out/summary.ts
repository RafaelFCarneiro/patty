import { z } from 'zod'
import { Period } from '../../models/common.js'
import { CurrencySummary } from '../../models/summary.js'

export const SpendingSummaryOut = z.object({
  period: Period,
  currencies: z.array(CurrencySummary),
})
export type SpendingSummaryOut = z.infer<typeof SpendingSummaryOut>
