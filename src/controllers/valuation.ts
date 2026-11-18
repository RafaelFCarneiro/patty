import type { ValuationContext } from '../logic/investment.js';
import { resolveBaseCurrency } from '../logic/locale.js';
import { decimalsLookup } from '../logic/money.js';
import { Locale } from '../models/locale.js';
import type { CurrencyCode } from '../models/money.js';
import type { Deps } from './deps.js';

export type ValuationBasis = { baseCurrency: CurrencyCode; baseDecimals: number; context: ValuationContext };

/** What a read-time valuation (ADR-026, ADR-038 §4) is made against: the caller's base currency, the currencies'
 *  decimals, every stored rate, the clock and the staleness windows. Gathered once per read. */
export const loadValuationBasis = async (deps: Deps): Promise<ValuationBasis> => {
  const [settingsRow, currencies, rates] = await Promise.all([
    deps.settings.getLocale(),
    deps.currencies.list(),
    deps.currencyRates.list(),
  ]);
  const baseCurrency = resolveBaseCurrency(settingsRow?.baseCurrency, settingsRow?.locale ?? Locale.enum.en);
  const decimalsOf = decimalsLookup(currencies);
  return {
    baseCurrency,
    baseDecimals: decimalsOf(baseCurrency),
    context: {
      rates,
      baseCurrency,
      decimalsOf,
      now: deps.clock(),
      rateThresholds: deps.rateStaleness,
      priceThresholds: deps.priceStaleness,
    },
  };
};
