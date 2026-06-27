import { z } from 'zod'
import { CurrencyCode } from './common.js'
import { MovementType } from './transaction.js'

export const SummaryRowSchema = z.object({
  currency: CurrencyCode,
  type: MovementType,
  category: z.string().nullable(),
  categoryNames: z.record(z.string(), z.string()).nullable(),
  total: z.number(),
  count: z.number().int(),
})
export type SummaryRow = z.infer<typeof SummaryRowSchema>

export const CategoryTotalSchema = z.object({
  category: z.string(),
  type: MovementType,
  total: z.number(),
  count: z.number().int(),
})
export type CategoryTotal = z.infer<typeof CategoryTotalSchema>

export const CurrencySummarySchema = z.object({
  currency: CurrencyCode,
  income: z.number(),
  expenses: z.number(),
  balance: z.number(),
  byCategory: z.array(CategoryTotalSchema),
})
export type CurrencySummary = z.infer<typeof CurrencySummarySchema>
