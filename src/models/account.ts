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

export const AccountSchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Current account name'),
  type: AccountType.describe('checking|savings|wallet|investment — only if no transactions'),
  typeLabel: z.string().optional(),
  currency: CurrencyCode.default(CurrencyCode.enum.USD).describe('Only if no transactions, no recurring rules, and not a card payer'),
  initialBalance: z.number().default(0),
})
export type Account = z.infer<typeof AccountSchema>

export const CreateAccountSchema = AccountSchema.omit({ 
  id: true, 
  typeLabel: true 
})
export type CreateAccount = z.infer<typeof CreateAccountSchema> 

export const UpdateAccountSchema = AccountSchema
  .omit({ id: true, typeLabel: true })
  .partial({
    initialBalance: true,
    type: true,
    currency: true
  }).extend({ 
    newName: z.string().min(1).optional().describe('New account name')
  })
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>

export const AccountBalanceSchema = AccountSchema.extend({
  balance: z.number(),
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
  projectedBalance: z.number().optional().describe('Effective balance + pending through projectedAsOf, if supplied'),
})
export type AccountBalance = z.infer<typeof AccountBalanceSchema>
