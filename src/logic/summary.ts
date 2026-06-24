import * as R from 'remeda'
import { purry } from 'remeda'
import { localizeCategoryName } from './category.js'
import type { CurrencyCode } from '../models/common.js'
import type { Locale } from '../models/locale.js'
import { TransactionType } from '../models/transaction.js'

/** Raw aggregation row from the database (transfers already excluded in SQL). */
export type SummaryRow = {
  currency: CurrencyCode
  type: TransactionType
  category: string | null
  categoryNames: Record<string, string> | null
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

const _toCurrencySummary = ([currency, rows]: [string, SummaryRow[]], locale: Locale): CurrencySummary => {
  const income = sumOf(rows, TransactionType.enum.income)
  const expenses = sumOf(rows, TransactionType.enum.expense)
  return {
    currency: currency as CurrencyCode,
    income,
    expenses,
    balance: roundMoney(income - expenses),
    byCategory: R.pipe(
      rows,
      R.map((r) => ({
        category: localizeCategoryName(r.category, r.categoryNames, locale) ?? uncategorizedLabels[locale],
        type: r.type,
        total: roundMoney(r.total),
        count: r.count,
      })),
      R.sortBy([(c) => c.total, 'desc']),
    ),
  }
}

function toCurrencySummary(entry: [string, SummaryRow[]], locale: Locale): CurrencySummary
function toCurrencySummary(locale: Locale): (entry: [string, SummaryRow[]]) => CurrencySummary
function toCurrencySummary(...args: readonly unknown[]) {
  return purry(_toCurrencySummary, args)
}

/** Group raw rows per currency — NEVER mix currencies in totals. */
export const summarize = (rows: readonly SummaryRow[], locale: Locale): CurrencySummary[] =>
  R.pipe(
    rows,
    R.groupBy((r) => r.currency),
    R.entries(),
    R.map(toCurrencySummary(locale)),
    R.sortBy((s) => s.currency),
  )
