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

/**
 * Domain entity: core node properties + edge refs handed to the persistence diplomat.
 * Pure write-side shape — flattening to db properties happens in diplomat/db via adapters/.
 */
export type Transaction = {
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

/** Read projection: Transaction node properties with graph-traversal names resolved. */
export const TransactionView = z.object({
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
export type TransactionView = z.infer<typeof TransactionView>

/** Domain patch for updates — only provided fields change; classification set on user correction. */
export type TransactionPatch = {
  description?: string
  amount?: number
  type?: MovementType
  date?: string
  currency?: CurrencyCode
  classification?: Classification
}

/** Natural input accepted by controllers: names instead of ids, optional date/currency. */
export type CreateTransactionInput = {
  description: string
  amount: number
  type: MovementType
  date?: string
  account?: string
  card?: string
  category?: string
  currency?: CurrencyCode
  idempotencyKey: string
  rawInput?: string
}

export type BulkTransactionItem = Omit<CreateTransactionInput, 'idempotencyKey' | 'rawInput'> & {
  idempotencyKey?: string
}

export type CreateTransactionsBulkInput = {
  items: BulkTransactionItem[]
  account?: string
  card?: string
  rawInput?: string
}

export type CreateTransferInput = {
  from: string
  to: string
  amount: number
  date?: string
  description?: string
  idempotencyKey: string
}

export type UpdateTransactionInput = {
  id: string
  description?: string
  amount?: number
  type?: MovementType
  date?: string
  account?: string
  category?: string
}

export type SearchTransactionsInput = {
  month?: number
  year?: number
  from?: string
  to?: string
  type?: TransactionType
  category?: string
  account?: string
  text?: string
  limit: number
}
