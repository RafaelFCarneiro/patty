import { z } from 'zod'
import { CurrencyCode } from './common.js'
import { MovementType } from './transaction.js'

export const SummaryRow = z.object({
  currency: CurrencyCode,
  type: MovementType,
  category: z.string().nullable(),
  categoryNames: z.record(z.string(), z.string()).nullable(),
  total: z.number(),
  count: z.number().int(),
})
export type SummaryRow = z.infer<typeof SummaryRow>

export const CategoryTotal = z.object({
  category: z.string(),
  type: MovementType,
  total: z.number(),
  count: z.number().int(),
})
export type CategoryTotal = z.infer<typeof CategoryTotal>

export const CurrencySummary = z.object({
  currency: CurrencyCode,
  income: z.number(),
  expenses: z.number(),
  balance: z.number(),
  byCategory: z.array(CategoryTotal),
})
export type CurrencySummary = z.infer<typeof CurrencySummary>
