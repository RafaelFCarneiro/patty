import { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import type { CreateCreditCard as Domain } from '../../models/creditCard.js'

export const CreateCreditCard = z
  .object({
    name: z.string().min(1),
    currency: CurrencyCode.optional(),
    closingDay: z.number().int().min(1).max(28),
    dueDay: z.number().int().min(1).max(28),
    limit: z.number().positive().optional(),
    paymentAccount: z.string().min(1).optional(),
  })
  .transform((input): Domain => ({
    name: input.name,
    currency: input.currency ?? 'BRL',
    closingDay: input.closingDay,
    dueDay: input.dueDay,
    limit: input.limit,
    paymentAccount: input.paymentAccount,
  }))
export type CreateCreditCard = z.infer<typeof CreateCreditCard>
