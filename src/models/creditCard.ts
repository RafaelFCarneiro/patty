import { z } from 'zod'
import { CurrencyCode, Id } from './common.js'

export const CreditCard = z.object({
  id: Id,
  name: z.string().min(1),
  currency: CurrencyCode,
  /** Day the bill (fatura) closes; transactions after this day go to next month's bill. */
  closingDay: z.number().int().min(1).max(28),
  /** Day the bill is due. */
  dueDay: z.number().int().min(1).max(28),
  limit: z.number().positive().optional(),
})
export type CreditCard = z.infer<typeof CreditCard>
