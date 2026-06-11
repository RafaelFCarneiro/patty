import { z } from 'zod'
import { CurrencyCode, Id, IsoDate, Money } from './common.js'

export const TransactionType = z.enum(['expense', 'income'])
export type TransactionType = z.infer<typeof TransactionType>

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
  categoryId: Id.optional(),
  categoryName: z.string().optional(),
  merchant: z.string().optional(),
})
export type Transaction = z.infer<typeof Transaction>

/** Natural input accepted by MCP/REST: names instead of ids, optional date/currency. */
export const CreateTransactionInput = z.object({
  description: z.string().min(1),
  amount: Money,
  type: TransactionType,
  date: IsoDate.optional(),
  account: z.string().optional(),
  category: z.string().optional(),
  currency: CurrencyCode.optional(),
  idempotencyKey: z.string().min(1),
  rawInput: z.string().optional(),
})
export type CreateTransactionInput = z.infer<typeof CreateTransactionInput>

export const UpdateTransactionInput = z.object({
  id: Id,
  description: z.string().min(1).optional(),
  amount: Money.optional(),
  type: TransactionType.optional(),
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
