import * as R from 'remeda'
import { periodRange } from '../logic/period.js'
import { summarize } from '../logic/summary.js'
import type { Period } from '../models/common.js'
import type { SpendingSummaryOut } from '../wire/out/summary.js'
import type { Deps } from './deps.js'

export const getSpendingSummary = async (deps: Deps, period: Period): Promise<SpendingSummaryOut> => {
  const { from, to } = periodRange(period)
  return R.pipe(
    await Promise.all([deps.transactions.summaryRows(from, to), deps.locale()]),
    ([rows, locale]) => ({ period, currencies: summarize(rows, locale) }),
  )
}
