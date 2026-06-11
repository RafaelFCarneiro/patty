import { z } from 'zod'
import { CurrencyCode, Id } from './common.js'

export const AccountType = z.enum(['checking', 'savings', 'wallet', 'investment'])
export type AccountType = z.infer<typeof AccountType>

export const Account = z.object({
  id: Id,
  name: z.string().min(1),
  type: AccountType,
  currency: CurrencyCode,
})
export type Account = z.infer<typeof Account>

export const CreateAccount = Account.omit({ id: true }).extend({
  currency: CurrencyCode.default('BRL'),
})
export type CreateAccount = z.infer<typeof CreateAccount>
