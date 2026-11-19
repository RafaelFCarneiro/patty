import { resolveBaseCurrency } from '../logic/locale.js';
import { decimalsLookup } from '../logic/money.js';
import type { ValuationBasis } from '../models/investment/core.js';
import { Locale } from '../models/locale.js';
import type { Deps } from './deps.js';

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
