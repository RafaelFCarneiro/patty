// Chrome / fixed-enum labels only — never dynamic content.
// Category names live on the entity (ADR-009); this catalog is for
// closed, code-defined enum values whose display labels need localization.
// Label maps live alongside their enum definitions in models/*.ts;
// this module provides the pure resolvers.

import { accountTypeLabels, type AccountType } from '../models/account.js'
import { billStatusLabels, type BillStatus } from '../models/bill.js'
import { categoryKindLabels, type CategoryKind } from '../models/category.js'
import type { LabelMap, Locale } from '../models/locale.js'
import { recurringPeriodLabels, type RecurringPeriod } from '../models/recurring.js'
import { transactionStatusLabels, transactionTypeLabels, type TransactionStatus, type TransactionType, type TransactionView } from '../models/transaction.js'

const localize = <E extends string>(map: LabelMap<E>, value: E, locale: Locale): string =>
  map[value][locale] ?? map[value].en

export const localizeAccountType       = (v: AccountType,       l: Locale): string => localize(accountTypeLabels, v, l)
export const localizeCategoryKind      = (v: CategoryKind,      l: Locale): string => localize(categoryKindLabels, v, l)
export const localizeRecurringPeriod   = (v: RecurringPeriod,   l: Locale): string => localize(recurringPeriodLabels, v, l)
export const localizeBillStatus        = (v: BillStatus,        l: Locale): string => localize(billStatusLabels, v, l)
export const localizeTransactionType   = (v: TransactionType,   l: Locale): string => localize(transactionTypeLabels, v, l)
export const localizeTransactionStatus = (v: TransactionStatus, l: Locale): string => localize(transactionStatusLabels, v, l)

export const withTransactionLabels = (locale: Locale) => (tx: TransactionView): TransactionView => ({
  ...tx,
  typeLabel: localizeTransactionType(tx.type, locale),
  statusLabel: localizeTransactionStatus(tx.status, locale),
})
