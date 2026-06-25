import { z } from 'zod'
import { CurrencyCode, Period } from '../../models/common.js'
import { TransactionType } from '../../models/transaction.js'

const CategoryTotalOut = z.object({
  category: z.string(),
  type: TransactionType,
  total: z.number(),
  count: z.number().int(),
})

const CurrencySummaryOut = z.object({
  currency: CurrencyCode,
  income: z.number(),
  expenses: z.number(),
  balance: z.number(),
  byCategory: z.array(CategoryTotalOut),
})

export const SpendingSummaryOut = z.object({
  period: Period,
  currencies: z.array(CurrencySummaryOut),
})
export type SpendingSummaryOut = z.infer<typeof SpendingSummaryOut>
