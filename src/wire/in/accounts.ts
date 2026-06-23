import { z } from 'zod'
import { CurrencyCode } from '../../models/common.js'
import { AccountType } from '../../models/account.js'
import type { CreateAccount as Domain } from '../../models/account.js'

export const CreateAccount = z
  .object({
    name: z.string().min(1),
    type: AccountType,
    currency: CurrencyCode.optional(),
    initialBalance: z.number().optional(),
  })
  .transform((input): Domain => ({
    name: input.name,
    type: input.type,
    currency: input.currency ?? 'BRL',
    initialBalance: input.initialBalance ?? 0,
  }))
export type CreateAccount = z.infer<typeof CreateAccount>

export const UpdateAccount = z.object({
  newName: z.string().min(1).optional(),
  initialBalance: z.number().optional(),
  type: AccountType.optional(),
  currency: CurrencyCode.optional(),
})
export type UpdateAccount = z.infer<typeof UpdateAccount>
