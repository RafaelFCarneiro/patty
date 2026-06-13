import { z } from 'zod'
import { CurrencyCode, Id } from './common.js'

export const AccountType = z.enum(['checking', 'savings', 'wallet', 'investment'])
export type AccountType = z.infer<typeof AccountType>

export const Account = z.object({
  id: Id,
  name: z.string().min(1),
  type: AccountType,
  currency: CurrencyCode,
  /** Balance at account creation; current balance is always derived from the graph. */
  initialBalance: z.number().default(0),
})
export type Account = z.infer<typeof Account>

/** An account with its derived current balance. */
export const AccountBalance = Account.extend({
  balance: z.number(),
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
})
export type AccountBalance = z.infer<typeof AccountBalance>

export type CreateAccount = {
  name: string
  type: AccountType
  currency: CurrencyCode
  initialBalance: number
}
