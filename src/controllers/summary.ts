import { periodRange } from '../logic/period.js'
import { summarize, type CurrencySummary } from '../logic/summary.js'
import type { Period } from '../models/common.js'
import type { Deps } from './deps.js'

export type SpendingSummary = { period: Period; currencies: CurrencySummary[] }

export const getSpendingSummary = async (deps: Deps, period: Period): Promise<SpendingSummary> => {
  const { from, to } = periodRange(period)
  const rows = await deps.transactions.summaryRows(from, to)
  return { period, currencies: summarize(rows) }
}
