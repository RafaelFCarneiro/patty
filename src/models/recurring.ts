import { z } from 'zod'
import { CurrencyCode, Id, IsoDate, Money } from './common.js'
import { MovementType } from './transaction.js'

export const RecurringPeriod = z.enum(['weekly', 'monthly', 'yearly'])
export type RecurringPeriod = z.infer<typeof RecurringPeriod>

export const RecurringRule = z.object({
  id: Id,
  description: z.string().min(1),
  amount: Money,
  type: MovementType,
  period: RecurringPeriod,
  /** Next date this rule should materialize a transaction. */
  nextDue: IsoDate,
  currency: CurrencyCode,
  accountId: Id.optional(),
  accountName: z.string().optional(),
  categoryId: Id.optional(),
  categoryName: z.string().optional(),
})
export type RecurringRule = z.infer<typeof RecurringRule>

export const CreateRecurringInput = z.object({
  description: z.string().min(1),
  amount: Money,
  type: MovementType,
  period: RecurringPeriod,
  /** First due date (YYYY-MM-DD). */
  startDate: IsoDate,
  account: z.string().optional(),
  category: z.string().optional(),
  currency: CurrencyCode.optional(),
})
export type CreateRecurringInput = z.infer<typeof CreateRecurringInput>
