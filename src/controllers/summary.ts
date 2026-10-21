import { consolidateInCurrency } from '../logic/currency-rate.js';
import { decimalsLookup } from '../logic/money.js';
import { periodRange } from '../logic/period.js';
import { summarize } from '../logic/summary.js';
import type { Period } from '../models/date.js';
import type { CurrencyCode } from '../models/money.js';
import type { SpendingSummaryOut } from '../wire/out/summary.js';
import type { Deps } from './deps.js';

export const getSpendingSummary = async (
  deps: Deps,
  periodInput: Period,
  displayCurrency?: CurrencyCode,
): Promise<SpendingSummaryOut> => {
  const period: Period = { month: periodInput.month, year: periodInput.year };
  const { from, to } = periodRange(period);
  const [rows, locale, currencies] = await Promise.all([
    deps.transactions.summaryRows(from, to),
    deps.locale(),
    deps.currencies.list(),
  ]);
  const decimalsFor = decimalsLookup(currencies);
  const currencySummaries = summarize(rows, locale, decimalsFor);
  if (!displayCurrency) return { period, currencies: currencySummaries };

  const rates = await deps.currencyRates.list();
  const amounts = currencySummaries.map((c) => ({ currency: c.currency, amount: c.expenses }));
  const converted = consolidateInCurrency(
    amounts,
    displayCurrency,
    rates,
    deps.clock(),
    deps.rateStaleness,
    decimalsFor(displayCurrency),
  );
  return { period, currencies: currencySummaries, converted: { displayCurrency, ...converted } };
};
