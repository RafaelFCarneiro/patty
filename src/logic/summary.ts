import * as R from 'remeda'
import type { CurrencyCode } from '../models/common.js'
import type { TransactionType } from '../models/transaction.js'

/** Raw aggregation row from the database (transfers already excluded in SQL). */
export type SummaryRow = {
  currency: CurrencyCode
  type: TransactionType
  category: string | null
  total: number
  count: number
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

const toCurrencySummary = ([currency, rows]: [string, SummaryRow[]]): CurrencySummary => {
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
        category: r.category ?? 'Sem categoria',
        type: r.type,
        total: roundMoney(r.total),
        count: r.count,
      })),
      R.sortBy([(c) => c.total, 'desc']),
    ),
  }
}

/** Group raw rows per currency — NEVER mix currencies in totals. */
export const summarize = (rows: readonly SummaryRow[]): CurrencySummary[] =>
  R.pipe(
    rows,
    R.groupBy((r) => r.currency),
    R.entries(),
    R.map(toCurrencySummary),
    R.sortBy((s) => s.currency),
  )
