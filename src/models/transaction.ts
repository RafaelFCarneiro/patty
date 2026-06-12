import { z } from 'zod'
import { CurrencyCode, Id, IsoDate, Money } from './common.js'

/** 'transfer' moves value between accounts: FROM + TO edges, excluded from summaries. */
export const TransactionType = z.enum(['expense', 'income', 'transfer'])
export type TransactionType = z.infer<typeof TransactionType>

/** Types accepted by create_transaction / bulk — transfers go through create_transfer. */
export const MovementType = z.enum(['expense', 'income'])
export type MovementType = z.infer<typeof MovementType>

export const ClassificationMethod = z.enum(['rule', 'graph', 'user', 'none'])
export type ClassificationMethod = z.infer<typeof ClassificationMethod>

export const Classification = z.object({
  method: ClassificationMethod,
  confidence: z.number().min(0).max(1),
})
export type Classification = z.infer<typeof Classification>

export const TransactionSource = z.enum(['mcp', 'rest', 'import'])
export type TransactionSource = z.infer<typeof TransactionSource>

export const Transaction = z.object({
  id: Id,
  description: z.string().min(1),
  amount: Money,
  type: TransactionType,
  date: IsoDate,
  currency: CurrencyCode,
  source: TransactionSource,
  idempotencyKey: z.string().min(1),
  classification: Classification,
  rawInput: z.string().optional(),
  accountId: Id.optional(),
  accountName: z.string().optional(),
  /** Destination account — present only on type 'transfer'. */
  toAccountId: Id.optional(),
  toAccountName: z.string().optional(),
  cardId: Id.optional(),
  cardName: z.string().optional(),
  categoryId: Id.optional(),
  categoryName: z.string().optional(),
  merchant: z.string().optional(),
})
export type Transaction = z.infer<typeof Transaction>

/**
 * Domain draft a controller hands to the persistence diplomat.
 * Pure model shape — flattening to db properties happens in diplomat/db via adapters/.
 */
export type TransactionDraft = {
  id: string
  description: string
  amount: number
  type: TransactionType
  date: string
  currency: CurrencyCode
  source: TransactionSource
  idempotencyKey: string
  classification: Classification
  rawInput?: string
  refs: {
    accountId?: string
    toAccountId?: string
    cardId?: string
    categoryId?: string
    merchantKey?: string
  }
}

/** Domain patch for updates — only provided fields change; classification set on user correction. */
export type TransactionPatch = {
  description?: string
  amount?: number
  type?: MovementType
  date?: string
  currency?: CurrencyCode
  classification?: Classification
}
