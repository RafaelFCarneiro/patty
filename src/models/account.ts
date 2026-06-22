import { z } from 'zod'
import { CurrencyCode, Id } from './common.js'
import type { LabelMap } from './locale.js'

export const AccountType = z.enum(['checking', 'savings', 'wallet', 'investment', 'credit'])
export type AccountType = z.infer<typeof AccountType>

export const accountTypeLabels: LabelMap<AccountType> = {
  checking:   { en: 'Checking',    pt: 'Conta corrente',    es: 'Cuenta corriente' },
  savings:    { en: 'Savings',     pt: 'Poupança',          es: 'Ahorros' },
  wallet:     { en: 'Wallet',      pt: 'Carteira',          es: 'Billetera' },
  investment: { en: 'Investment',  pt: 'Investimentos',     es: 'Inversiones' },
  credit:     { en: 'Credit card', pt: 'Cartão de crédito', es: 'Tarjeta de crédito' },
}

export const Account = z.object({
  id: Id,
  name: z.string().min(1),
  type: AccountType,
  typeLabel: z.string().optional(),
  currency: CurrencyCode,
  /** Balance at account creation; current balance is always derived (initial + income − expenses ± transfers). */
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
  /** Present only when projectedAsOf was supplied; effective balance + pending through that date. */
  projectedBalance: z.number().optional(),
})
export type AccountBalance = z.infer<typeof AccountBalance>

export type CreateAccount = {
  name: string
  type: AccountType
  currency: CurrencyCode
  initialBalance: number
}
