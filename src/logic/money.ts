import * as R from 'remeda';
import { CurrencyCode, type Currency, type DecimalsFor, FIAT_DECIMALS, type CurrencySource } from '../models/money.js';

export const decimalsLookup = (currencies: readonly Currency[]): DecimalsFor => {
  const byCode = R.indexBy(currencies, (c) => c.code);
  return (code) => byCode[code]?.decimals ?? FIAT_DECIMALS;
};

export const resolveCurrency = (source: CurrencySource | null, input: { currency?: CurrencyCode }): CurrencyCode =>
  source?.currency ?? input.currency ?? CurrencyCode.enum.USD;

export const roundToDecimals = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const roundMoney = (value: number): number => roundToDecimals(value, FIAT_DECIMALS);
