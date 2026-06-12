import { z } from 'zod'
import { CurrencyCode, IsoDate, Money } from '../../models/common.js'
import { MovementType, TransactionType } from '../../models/transaction.js'

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
  id: z.string().min(1),
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
