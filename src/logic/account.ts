import { purry } from 'remeda'
import { localizeAccountType } from './labels.js'
import type { Account, AccountType } from '../models/account.js'
import type { Locale } from '../models/locale.js'

export const filterByType = (type?: AccountType) => (a: Account): boolean =>
  !type || a.type === type

const _withTypeLabel = <T extends Account>(account: T, locale: Locale): T => ({
  ...account,
  typeLabel: localizeAccountType(account.type, locale),
})

export function withTypeLabel<T extends Account>(account: T, locale: Locale): T
export function withTypeLabel(locale: Locale): <T extends Account>(account: T) => T
export function withTypeLabel(...args: readonly unknown[]) {
  return purry(_withTypeLabel, args)
}
