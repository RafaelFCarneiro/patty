import * as R from 'remeda';
import { decimalsLookup } from '../logic/money.js';
import { periodRange } from '../logic/period.js';
import { summarize } from '../logic/summary.js';
import type { Period } from '../models/date.js';
import type { SpendingSummaryOut } from '../wire/out/summary.js';
import type { Deps } from './deps.js';

export const getSpendingSummary = async (deps: Deps, period: Period): Promise<SpendingSummaryOut> => {
  const { from, to } = periodRange(period);
  return R.pipe(
    await Promise.all([deps.transactions.summaryRows(from, to), deps.locale(), deps.currencies.list()]),
    ([rows, locale, currencies]) => ({
      period,
      currencies: summarize(rows, locale, decimalsLookup(currencies)),
    }),
  );
};
