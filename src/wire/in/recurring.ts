import { z } from 'zod'
import { CurrencyCode, IsoDate, Money } from '../../models/common.js'
import { MovementType } from '../../models/transaction.js'
import { RecurringPeriod } from '../../models/recurring.js'

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
