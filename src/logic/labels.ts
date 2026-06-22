// Chrome / fixed-enum labels only — never dynamic content.
// Category names live on the entity (ADR-009); this catalog is for
// closed, code-defined enum values whose display labels need localization.

import type { AccountType } from '../models/account.js'
import type { BillStatus } from '../models/bill.js'
import type { CategoryKind } from '../models/category.js'
import type { Locale } from '../models/locale.js'
import type { RecurringPeriod } from '../models/recurring.js'
import type { TransactionStatus, TransactionType } from '../models/transaction.js'

type LabelMap<E extends string> = Record<E, Record<Locale, string>>

const accountTypeLabels: LabelMap<AccountType> = {
  checking:   { en: 'Checking',    pt: 'Conta corrente',    es: 'Cuenta corriente' },
  savings:    { en: 'Savings',     pt: 'Poupança',          es: 'Ahorros' },
  wallet:     { en: 'Wallet',      pt: 'Carteira',          es: 'Billetera' },
  investment: { en: 'Investment',  pt: 'Investimentos',     es: 'Inversiones' },
  credit:     { en: 'Credit card', pt: 'Cartão de crédito', es: 'Tarjeta de crédito' },
}

const categoryKindLabels: LabelMap<CategoryKind> = {
  expense: { en: 'Expense', pt: 'Despesa', es: 'Gasto' },
  income:  { en: 'Income',  pt: 'Receita', es: 'Ingreso' },
  both:    { en: 'Both',    pt: 'Ambos',   es: 'Ambos' },
}

const recurringPeriodLabels: LabelMap<RecurringPeriod> = {
  weekly:  { en: 'Weekly',  pt: 'Semanal', es: 'Semanal' },
  monthly: { en: 'Monthly', pt: 'Mensal',  es: 'Mensual' },
  yearly:  { en: 'Yearly',  pt: 'Anual',   es: 'Anual' },
}

const billStatusLabels: LabelMap<BillStatus> = {
  open:   { en: 'Open',   pt: 'Aberta',  es: 'Abierta' },
  closed: { en: 'Closed', pt: 'Fechada', es: 'Cerrada' },
  paid:   { en: 'Paid',   pt: 'Paga',    es: 'Pagada' },
}

const transactionTypeLabels: LabelMap<TransactionType> = {
  expense:  { en: 'Expense',  pt: 'Despesa',       es: 'Gasto' },
  income:   { en: 'Income',   pt: 'Receita',       es: 'Ingreso' },
  transfer: { en: 'Transfer', pt: 'Transferência', es: 'Transferencia' },
}

const transactionStatusLabels: LabelMap<TransactionStatus> = {
  pending:   { en: 'Pending',   pt: 'Pendente',   es: 'Pendiente' },
  effective: { en: 'Effective', pt: 'Efetivada',  es: 'Efectiva' },
}

const localize = <E extends string>(map: LabelMap<E>, value: E, locale: Locale): string =>
  map[value][locale] ?? map[value].en

export const localizeAccountType       = (v: AccountType,       l: Locale): string => localize(accountTypeLabels, v, l)
export const localizeCategoryKind      = (v: CategoryKind,      l: Locale): string => localize(categoryKindLabels, v, l)
export const localizeRecurringPeriod   = (v: RecurringPeriod,   l: Locale): string => localize(recurringPeriodLabels, v, l)
export const localizeBillStatus        = (v: BillStatus,        l: Locale): string => localize(billStatusLabels, v, l)
export const localizeTransactionType   = (v: TransactionType,   l: Locale): string => localize(transactionTypeLabels, v, l)
export const localizeTransactionStatus = (v: TransactionStatus, l: Locale): string => localize(transactionStatusLabels, v, l)
