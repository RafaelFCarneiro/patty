import { z } from 'zod'
import { CurrencyCode, Id } from './common.js'
import type { Ambiguous, DuplicateName, InUse, NotFound, ValidationError } from './error.js'
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

export type AccountError =
  | NotFound<'account'>
  | Ambiguous<'account'>
  | DuplicateName<'account'>
  | InUse<'account', AccountReferences>
  | ValidationError

export const accountErrors = {
  creditRejected: {
    code: 'validation',
    issues: ['credit accounts are managed by their credit card — use the card flow instead (create_credit_card / delete_credit_card)'],
  } satisfies AccountError,
  duplicateName: (name: string): AccountError => ({ code: 'duplicate_name', entity: 'account', name }),
  inUse: (name: string, references: AccountReferences): AccountError => ({
    code: 'in_use', entity: 'account', name, references,
  }),
  typeImmutable: (transactions: number): AccountError => ({
    code: 'validation',
    issues: [`type cannot be changed — account has ${transactions} transaction(s)`],
  }),
  currencyImmutableTransactions: (transactions: number): AccountError => ({
    code: 'validation',
    issues: [`currency cannot be changed — account has ${transactions} transaction(s)`],
  }),
  currencyImmutableRecurring: {
    code: 'validation',
    issues: ['currency cannot be changed — account has recurring rules that persist the original currency'],
  } satisfies AccountError,
  currencyImmutableCards: {
    code: 'validation',
    issues: ['currency cannot be changed — account is a credit card payment account'],
  } satisfies AccountError,
  creditPostRejected: {
    code: 'validation',
    issues: ['cannot post directly to a credit account — use the card parameter instead'],
  } satisfies AccountError,
  creditTransferRejected: (name: string): AccountError => ({
    code: 'validation',
    issues: [`cannot transfer from a credit account (${name}) — use pay_bill instead`],
  }),
  creditPaymentRejected: {
    code: 'validation',
    issues: ['payment account cannot be a credit account'],
  } satisfies AccountError,
  currencyMismatch: (a: string, b: string): AccountError => ({
    code: 'validation',
    issues: [`currency mismatch: card is ${a}, payer is ${b}`],
  }),
  sameAccount: {
    code: 'validation',
    issues: ['from and to must be different accounts'],
  } satisfies AccountError,
  crossCurrencyTransfer: (from: { name: string; currency: string }, to: { name: string; currency: string }): AccountError => ({
    code: 'validation',
    issues: [`cross-currency transfer not supported yet: ${from.name} is ${from.currency}, ${to.name} is ${to.currency}`],
  }),
}
