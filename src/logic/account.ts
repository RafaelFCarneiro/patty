import { localizeAccountType } from './labels.js'
import type { Account, AccountType } from '../models/account.js'
import type { Locale } from '../models/locale.js'

export const filterByType = (type?: AccountType) => (a: Account): boolean =>
  !type || a.type === type

export const withTypeLabel = (locale: Locale) => <T extends Account>(account: T): T => ({
  ...account,
  typeLabel: localizeAccountType(account.type, locale),
})
