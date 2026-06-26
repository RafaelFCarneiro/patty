import { z } from 'zod'
import { CurrencyCode, Id } from './common.js'
import type { Ambiguous, DuplicateName, NotFound, ValidationError } from './error.js'

export const CreditCard = z.object({
  id: Id,
  name: z.string().min(1),
  currency: CurrencyCode,
  /** Day the bill (fatura) closes; transactions after this day go to next month's bill. */
  closingDay: z.number().int().min(1).max(28),
  /** Day the bill is due. */
  dueDay: z.number().int().min(1).max(28),
  limit: z.number().positive().optional(),
  /** The card's internal liability account (ADR-010). */
  accountId: Id,
  /** Default paying account for bill payment. */
  paymentAccountId: Id.optional(),
})
export type CreditCard = z.infer<typeof CreditCard>

export type CreateCreditCard = {
  name: string
  currency: CurrencyCode
  closingDay: number
  dueDay: number
  limit?: number
  paymentAccount?: string
}

export type CardError =
  | NotFound<'card'>
  | Ambiguous<'card'>
  | DuplicateName<'credit_card'>
  | ValidationError

export const cardErrors = {
  duplicateName: (name: string): CardError => ({ code: 'duplicate_name', entity: 'credit_card', name }),
  currencyMismatch: (cardCurrency: string, accountCurrency: string): CardError => ({
    code: 'validation',
    issues: [`currency mismatch: card is ${cardCurrency}, payment account is ${accountCurrency}`],
  }),
}
