import { z } from 'zod'
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
export type CreateTransactionInput = z.infer<typeof CreateTransactionSchema>

export const BulkTransactionItem = CreateTransactionsBulkSchema.shape.items.element
export type BulkTransactionItem = z.infer<typeof BulkTransactionItem>

export const CreateTransactionsBulkInput = CreateTransactionsBulkSchema
export type CreateTransactionsBulkInput = z.infer<typeof CreateTransactionsBulkSchema>

export const CreateTransferInput = CreateTransferSchema
export type CreateTransferInput = z.infer<typeof CreateTransferSchema>

export const UpdateTransactionInput = UpdateTransactionSchema
export type UpdateTransactionInput = z.infer<typeof UpdateTransactionSchema>

export const SearchTransactionsInput = SearchTransactionsSchema
  .extend({ limit: SearchTransactionsSchema.shape.limit.optional() })
  .transform((input): SearchTransactions => ({ ...input, limit: input.limit ?? 50 }))
export type SearchTransactionsInput = SearchTransactions
