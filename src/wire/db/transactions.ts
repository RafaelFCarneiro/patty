import { z } from 'zod'

export type TransactionDbProps = {
  id: string
  description: string
  amount: number
  type: string
  date: string
  currency: string
  source: string
  idempotencyKey: string
  classificationMethod: string
  confidence: number
  rawInput: string | null
}

export type TransactionDbRefs = {
  accountId: string | null
  toAccountId: string | null
  cardId: string | null
  categoryId: string | null
  subCategoryId: string | null
  merchantKey: string | null
}

export const SummaryRowSchema = z.object({
  currency: z.enum(['BRL', 'USD']),
  type: z.enum(['expense', 'income']),
  category: z.string().nullable(),
  total: z.number(),
  count: z.number(),
})
