import { CurrencyCode } from '../models/money.js';

/** Anything that denormalizes a fixed currency onto the transactions it funds — an account or a credit card. */
type CurrencySource = { currency: CurrencyCode };

/** Resolve transaction currency: the funding source (account or card) > explicit input > USD default. */
export const resolveCurrency = (
  source: CurrencySource | null,
  input: { currency?: CurrencyCode },
): CurrencyCode => source?.currency ?? input.currency ?? CurrencyCode.enum.USD;

/** Rounds to 2 decimal places, correcting the classic floating-point drift (e.g. `1.005 * 100`
 *  landing on `100.49999...`) via `Number.EPSILON` before rounding. Shared by every `logic/`
 *  module that shapes a money total for a read response (aggregate/summary/correlations). */
export const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
