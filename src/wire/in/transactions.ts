import {
  CreateTransactionSchema,
  CreateTransactionsBulkSchema,
  CreateTransferSchema,
  SearchTransactionsSchema,
  UpdateTransactionSchema,
} from '../../models/transaction.js'
import type { SearchTransactions } from '../../models/transaction.js'

// Wire input schemas — derived from model schemas.
// Boundary-only behavior (limit default) stays here; everything else is pass-through.

export const CreateTransactionInput = CreateTransactionSchema
export type CreateTransactionInput = typeof CreateTransactionSchema._type

export const BulkTransactionItem = CreateTransactionsBulkSchema.shape.items.element
export type BulkTransactionItem = typeof BulkTransactionItem._type

export const CreateTransactionsBulkInput = CreateTransactionsBulkSchema
export type CreateTransactionsBulkInput = typeof CreateTransactionsBulkSchema._type

export const CreateTransferInput = CreateTransferSchema
export type CreateTransferInput = typeof CreateTransferSchema._type

export const UpdateTransactionInput = UpdateTransactionSchema
export type UpdateTransactionInput = typeof UpdateTransactionSchema._type

export const SearchTransactionsInput = SearchTransactionsSchema
  .extend({ limit: SearchTransactionsSchema.shape.limit.optional() })
  .transform((input): SearchTransactions => ({ ...input, limit: input.limit ?? 50 }))
export type SearchTransactionsInput = SearchTransactions
