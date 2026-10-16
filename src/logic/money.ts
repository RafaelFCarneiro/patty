import * as R from 'remeda';
import { CurrencyCode, type Currency, type DecimalsFor } from '../models/money.js';

/** Fiat's own fractional digits — the fallback when a currency is missing from the reference list
 *  and `roundMoney`'s fixed default (see below). */
const FIAT_DECIMALS = 2;

/** Builds a `DecimalsFor` lookup from the currencies reference list; a code missing from the list
 *  (should not happen — every `CurrencyCode` is seeded) falls back to fiat's decimals. */
export const decimalsLookup = (currencies: readonly Currency[]): DecimalsFor => {
  const byCode = R.indexBy(currencies, (c) => c.code);
  return (code) => byCode[code]?.decimals ?? FIAT_DECIMALS;
};

/** Anything that denormalizes a fixed currency onto the transactions it funds — an account or a credit card. */
type CurrencySource = { currency: CurrencyCode };

/** Resolve transaction currency: the funding source (account or card) > explicit input > USD default. */
export const resolveCurrency = (source: CurrencySource | null, input: { currency?: CurrencyCode }): CurrencyCode =>
  source?.currency ?? input.currency ?? CurrencyCode.enum.USD;

/** Rounds to `decimals` places, correcting floating-point drift (e.g. `1.005 * 100` landing on
 *  `100.49999...`) via `Number.EPSILON` before rounding. Money-amount rounding must go through
 *  this with the amount's own currency decimals (ADR-026) — flattening a native BTC amount (8
 *  decimals) to a fiat-shaped 2 would corrupt it. */
export const roundToDecimals = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

/** Fiat-shaped 2-decimal rounding — the default for values with no specific currency (a
 *  cross-currency ratio/percentage) or where the amount is already known fiat. Money amounts that
 *  can be a non-fiat currency must use `roundToDecimals` with that currency's own decimals instead. */
export const roundMoney = (value: number): number => roundToDecimals(value, FIAT_DECIMALS);
