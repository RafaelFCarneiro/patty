import { z } from 'zod'
import type { AppError } from '../common/errors.js'
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

// `.describe()` is domain information — it states what each field is and represents.
// Defaults split by intent: integrity defaults (a value that must exist for the entity to be
// valid, e.g. initialBalance → 0) live here; quality-of-life convenience defaults live at the
// wire boundary (see wire/in/accounts.ts), keeping the domain contract honest about what is required.
export const AccountSchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Account name'),
  type: AccountType.describe('checking | savings | wallet | investment (credit is card-managed)'),
  typeLabel: z.string().optional(),
  currency: CurrencyCode.describe('Account currency (ISO code); fixed once the account has activity'),
  initialBalance: z.number().default(0).describe('Balance at account creation; current balance is always derived'),
})
export type Account = z.infer<typeof AccountSchema>

export const CreateAccountSchema = AccountSchema.omit({ id: true, typeLabel: true })
export type CreateAccount = z.infer<typeof CreateAccountSchema>

export const UpdateAccountSchema = AccountSchema.omit({ id: true, typeLabel: true })
  .partial({ initialBalance: true, type: true, currency: true })
  .extend({ newName: z.string().min(1).optional().describe('New account name') })
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

/**
 * What counts as a reference to an account — the domain's definition of what blocks
 * destructive/structural changes (delete, type/currency edits). The repo populates the counts;
 * `logic/account.ts` predicates interpret them.
 */
export type AccountReferences = { transactions: number; recurring: number; cards: number }

/**
 * Expected-error payloads are domain vocabulary, colocated with the model.
 * Controllers raise them via `guard(condition, accountErrors.X)`; the condition lives in
 * logic/ (pure predicate) or the controller (when it needs the repo) — never the payload.
 */
export const accountErrors = {
  creditRejected: {
    code: 'validation',
    issues: ['credit accounts are managed by their credit card — use the card flow instead (create_credit_card / delete_credit_card)'],
  } satisfies AppError,
  duplicateName: (name: string): AppError => ({ code: 'duplicate_name', entity: 'account', name }),
  inUse: (name: string, references: AccountReferences): AppError => ({
    code: 'in_use', entity: 'account', name, references,
  }),
  typeImmutable: (transactions: number): AppError => ({
    code: 'validation',
    issues: [`type cannot be changed — account has ${transactions} transaction(s)`],
  }),
  currencyImmutableTransactions: (transactions: number): AppError => ({
    code: 'validation',
    issues: [`currency cannot be changed — account has ${transactions} transaction(s)`],
  }),
  currencyImmutableRecurring: {
    code: 'validation',
    issues: ['currency cannot be changed — account has recurring rules that persist the original currency'],
  } satisfies AppError,
  currencyImmutableCards: {
    code: 'validation',
    issues: ['currency cannot be changed — account is a credit card payment account'],
  } satisfies AppError,
}
