import { periodRange } from '../logic/period.js'
import { summarize, type CurrencySummary } from '../logic/summary.js'
import type { Period } from '../models/common.js'
import type { Deps } from './deps.js'

export type SpendingSummary = { period: Period; currencies: CurrencySummary[] }

export const getSpendingSummary = async (deps: Deps, period: Period): Promise<SpendingSummary> => {
  const { from, to } = periodRange(period)
  const [rows, locale] = await Promise.all([deps.transactions.summaryRows(from, to), deps.locale()])
  return { period, currencies: summarize(rows, locale) }
}
