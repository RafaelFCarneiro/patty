import type { CurrencyCode } from '../models/common.js'
import type { TransactionType } from '../models/transaction.js'

/** Raw aggregation row from the graph. */
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

/** Group raw rows per currency — NEVER mix currencies in totals. */
export const summarize = (rows: readonly SummaryRow[]): CurrencySummary[] => {
  const currencies = [...new Set(rows.map((r) => r.currency))].sort()
  return currencies.map((currency) => {
    const mine = rows.filter((r) => r.currency === currency)
    const sum = (t: TransactionType) =>
      mine.filter((r) => r.type === t).reduce((acc, r) => acc + r.total, 0)
    const income = sum('income')
    const expenses = sum('expense')
    return {
      currency,
      income,
      expenses,
      balance: income - expenses,
      byCategory: mine
        .map((r) => ({
          category: r.category ?? 'Sem categoria',
          type: r.type,
          total: r.total,
          count: r.count,
        }))
        .sort((a, b) => b.total - a.total),
    }
  })
}
