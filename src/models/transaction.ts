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

/** Natural input accepted by MCP/REST: names instead of ids, optional date/currency. */
export const CreateTransactionInput = z.object({
  description: z.string().min(1),
  amount: Money,
  type: MovementType,
  date: IsoDate.optional(),
  account: z.string().optional(),
  card: z.string().optional(),
  category: z.string().optional(),
  currency: CurrencyCode.optional(),
  idempotencyKey: z.string().min(1),
  rawInput: z.string().optional(),
})
export type CreateTransactionInput = z.infer<typeof CreateTransactionInput>

/** Bulk item: idempotencyKey optional — derived from date+description+amount when absent. */
export const BulkTransactionItem = CreateTransactionInput.omit({
  idempotencyKey: true,
  rawInput: true,
}).extend({
  idempotencyKey: z.string().min(1).optional(),
})
export type BulkTransactionItem = z.infer<typeof BulkTransactionItem>

export const CreateTransactionsBulkInput = z.object({
  items: z.array(BulkTransactionItem).min(1).max(200),
  /** Defaults applied to every item that doesn't set its own. */
  account: z.string().optional(),
  card: z.string().optional(),
  rawInput: z.string().optional(),
})
export type CreateTransactionsBulkInput = z.infer<typeof CreateTransactionsBulkInput>

export const CreateTransferInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  amount: Money,
  date: IsoDate.optional(),
  description: z.string().optional(),
  idempotencyKey: z.string().min(1),
})
export type CreateTransferInput = z.infer<typeof CreateTransferInput>

export const UpdateTransactionInput = z.object({
  id: Id,
  description: z.string().min(1).optional(),
  amount: Money.optional(),
  type: MovementType.optional(),
  date: IsoDate.optional(),
  account: z.string().optional(),
  category: z.string().optional(),
})
export type UpdateTransactionInput = z.infer<typeof UpdateTransactionInput>

export const SearchTransactionsInput = z.object({
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  type: TransactionType.optional(),
  category: z.string().optional(),
  account: z.string().optional(),
  text: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
export type SearchTransactionsInput = z.infer<typeof SearchTransactionsInput>
