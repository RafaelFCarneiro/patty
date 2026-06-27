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

export const CreateTransactionInputSchema = CreateTransactionSchema
export type CreateTransactionInput = z.infer<typeof CreateTransactionInputSchema>

export const BulkTransactionItemSchema = CreateTransactionsBulkSchema.shape.items.element
export type BulkTransactionItem = z.infer<typeof BulkTransactionItemSchema>

export const CreateTransactionsBulkInputSchema = CreateTransactionsBulkSchema
export type CreateTransactionsBulkInput = z.infer<typeof CreateTransactionsBulkInputSchema>

export const CreateTransferInputSchema = CreateTransferSchema
export type CreateTransferInput = z.infer<typeof CreateTransferInputSchema>

export const UpdateTransactionInputSchema = UpdateTransactionSchema
export type UpdateTransactionInput = z.infer<typeof UpdateTransactionInputSchema>

export const SearchTransactionsInputSchema = SearchTransactionsSchema
  .extend({ limit: SearchTransactionsSchema.shape.limit.optional() })
  .transform((input): SearchTransactions => ({ ...input, limit: input.limit ?? 50 }))
export type SearchTransactionsInput = z.output<typeof SearchTransactionsInputSchema>
