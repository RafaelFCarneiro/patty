import * as R from 'remeda'
import { localizeCategoryName } from './category.js'
import type { CurrencyCode } from '../models/common.js'
import type { Locale } from '../models/locale.js'
import type { TransactionType } from '../models/transaction.js'

/** Raw aggregation row from the database (transfers already excluded in SQL). */
export type SummaryRow = {
  currency: CurrencyCode
  type: TransactionType
  category: string | null
  category_names: string | null
  total: number
  count: number
}

const uncategorizedLabels: Record<Locale, string> = {
  en: 'Uncategorized',
  pt: 'Sem categoria',
  es: 'Sin categoría',
}

export type CategoryTotal = { category: string; type: TransactionType; total: number; count: number }

export type CurrencySummary = {
  currency: CurrencyCode
  income: number
  expenses: number
  balance: number
  byCategory: CategoryTotal[]
}

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100

const sumOf = (rows: readonly SummaryRow[], type: TransactionType): number =>
  roundMoney(
    R.pipe(
      rows,
      R.filter((r) => r.type === type),
      R.sumBy((r) => r.total),
    ),
  )

const parseNames = (raw: string | null): Record<string, string> | null =>
  raw ? JSON.parse(raw) as Record<string, string> : null

const toCurrencySummary = ([currency, rows]: [string, SummaryRow[]], locale: Locale): CurrencySummary => {
  const income = sumOf(rows, 'income')
  const expenses = sumOf(rows, 'expense')
  return {
    currency: currency as CurrencyCode,
    income,
    expenses,
    balance: roundMoney(income - expenses),
    byCategory: R.pipe(
      rows,
      R.map((r) => ({
        category: localizeCategoryName(r.category ?? undefined, parseNames(r.category_names), locale) ?? uncategorizedLabels[locale],
        type: r.type,
        total: roundMoney(r.total),
        count: r.count,
      })),
      R.sortBy([(c) => c.total, 'desc']),
    ),
  }
}

/** Group raw rows per currency — NEVER mix currencies in totals. */
export const summarize = (rows: readonly SummaryRow[], locale: Locale): CurrencySummary[] =>
  R.pipe(
    rows,
    R.groupBy((r) => r.currency),
    R.entries(),
    R.map((entry) => toCurrencySummary(entry, locale)),
    R.sortBy((s) => s.currency),
  )
