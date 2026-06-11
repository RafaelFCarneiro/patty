import { z } from 'zod'
import { CurrencyCode, Id, IsoDate, Money } from './common.js'

/**
 * A transfer moves value between two accounts. It is NOT an expense or income —
 * transfers never appear in spending summaries.
 */
export const Transfer = z.object({
  id: Id,
  amount: Money,
  date: IsoDate,
  currency: CurrencyCode,
  description: z.string().optional(),
  idempotencyKey: z.string().min(1),
  fromAccountId: Id,
  fromAccountName: z.string(),
  toAccountId: Id,
  toAccountName: z.string(),
})
export type Transfer = z.infer<typeof Transfer>

export const CreateTransferInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  amount: Money,
  date: IsoDate.optional(),
  description: z.string().optional(),
  idempotencyKey: z.string().min(1),
})
export type CreateTransferInput = z.infer<typeof CreateTransferInput>
