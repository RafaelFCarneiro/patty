import { z } from 'zod'
import { TransactionStatus } from '../../models/transaction.js'
import type { transactions } from '../../diplomat/db/schema.js'

// Inferred Drizzle select type — the canonical shape of a transactions row.
export type TransactionRow = typeof transactions.$inferSelect

// The columns dbToModel consumes from the full transaction SELECT (node columns +
// LEFT JOINed related names/tags). Decoded at the boundary before mapping to the model;
// unrelated columns the SELECT may also return (e.g. bill_id) are ignored by z.object.
export const TransactionRowSchema = z.object({
  id:                    z.string(),
  description:           z.string(),
  amount:                z.number(),
  type:                  z.string(),
  status:                TransactionStatus,
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
  tags:                  z.string().nullable(), // JSON array from json_group_array
})

// Flat node properties handed to the INSERT. `type` is derived from the Drizzle schema
// so the repo never casts the string into the column's enum union.
export type TransactionDbProps = {
  id: string
  description: string
  amount: number
  type: TransactionRow['type']
  status: TransactionRow['status']
  date: string
  currency: string
  source: TransactionRow['source']
  idempotencyKey: string
  classificationMethod: TransactionRow['classificationMethod']
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
// Decoded summary row shape — kept in wire/db so the repo doesn't import a logic type.
export type SummaryRow = z.infer<typeof SummaryRowSchema>
