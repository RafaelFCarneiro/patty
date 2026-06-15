import { z } from 'zod'
import type { transactions } from '../../diplomat/db/schema.js'

// Inferred Drizzle select type — the canonical shape of a transactions row.
export type TransactionRow = typeof transactions.$inferSelect

// Flat SQL row returned by the full SELECT (with LEFT JOINed columns for related names/tags).
// Repos decode every row through this schema before passing data to adapters.
export const TransactionRowSchema = z.object({
  id:                    z.string(),
  description:           z.string(),
  amount:                z.number(),
  type:                  z.string(),
  date:                  z.string(),
  currency:              z.string(),
  source:                z.string(),
  idempotency_key:       z.string(),
  classification_method: z.string(),
  confidence:            z.number(),
  raw_input:             z.string().nullable(),
  from_account_id:       z.string().nullable(),
  from_account_name:     z.string().nullable(),
  to_account_id:         z.string().nullable(),
  to_account_name:       z.string().nullable(),
  credit_card_id:        z.string().nullable(),
  credit_card_name:      z.string().nullable(),
  category_id:           z.string().nullable(),
  category_name:         z.string().nullable(),
  subcategory_id:        z.string().nullable(),
  subcategory_name:      z.string().nullable(),
  merchant_key:          z.string().nullable(),
  bill_id:               z.string().nullable(),
  tags:                  z.string().nullable(), // JSON array from json_group_array
})

// Legacy flat props/refs — used by adapters/transactions.ts until it is rewritten in PR 5.
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
  type:     z.enum(['expense', 'income']),
  category: z.string().nullable(),
  total:    z.number(),
  count:    z.number(),
})
