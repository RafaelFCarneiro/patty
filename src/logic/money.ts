import { CurrencyCode } from '../models/money.js';

/** Anything that denormalizes a fixed currency onto the transactions it funds — an account or a credit card. */
type CurrencySource = { currency: CurrencyCode };

/** Resolve transaction currency: the funding source (account or card) > explicit input > USD default. */
export const resolveCurrency = (
  source: CurrencySource | null,
  input: { currency?: CurrencyCode },
): CurrencyCode => source?.currency ?? input.currency ?? CurrencyCode.enum.USD;
