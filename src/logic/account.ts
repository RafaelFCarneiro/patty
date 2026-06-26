import { purry } from 'remeda'
import { localizeAccountType } from './localize.js'
import { AccountType } from '../models/account.js'
import type { Account, AccountReferences } from '../models/account.js'
import type { Locale } from '../models/locale.js'

export const filterByType = (type?: AccountType) => (a: Account): boolean =>
  !type || a.type === type

/**
 * Manual create/update may not target credit accounts — those are card-managed.
 * Pure guard condition (no I/O): `guard(assertNonCreditType(type), accountErrors.creditRejected)`.
 * `undefined` passes — an omitted type on update is not a credit assignment.
 */
export const assertNonCreditType = (type?: AccountType): boolean =>
  type !== AccountType.enum.credit

// Reference predicates — pure interpretations of AccountReferences, paired with `guard` at call sites.
// Each reads as the precondition that must hold (true = the change is allowed).
export const hasNoTransactions = (refs: AccountReferences): boolean => refs.transactions === 0
export const hasNoRecurring = (refs: AccountReferences): boolean => refs.recurring === 0
export const hasNoCards = (refs: AccountReferences): boolean => refs.cards === 0
export const isUnreferenced = (refs: AccountReferences): boolean =>
  hasNoTransactions(refs) && hasNoRecurring(refs) && hasNoCards(refs)

const _withTypeLabel = <T extends Account>(account: T, locale: Locale): T => ({
  ...account,
  typeLabel: localizeAccountType(account.type, locale),
})

export function withTypeLabel<T extends Account>(account: T, locale: Locale): T
export function withTypeLabel(locale: Locale): <T extends Account>(account: T) => T
export function withTypeLabel(...args: readonly unknown[]) {
  return purry(_withTypeLabel, args)
}
