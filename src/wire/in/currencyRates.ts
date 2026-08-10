import { z } from 'zod';
import { SetExchangeRateSchema } from '../../models/currencyRate.js';

// Caps a single bulk call — an agent refreshing rates after a web pull touches a handful of
// pairs, never hundreds; keeps one call bounded rather than an unbounded array.
const MAX_BULK_EXCHANGE_RATES = 50;

export const SetExchangeRatesSchema = z.object({
  rates: z.array(SetExchangeRateSchema).min(1).max(MAX_BULK_EXCHANGE_RATES),
});
export type SetExchangeRates = z.infer<typeof SetExchangeRatesSchema>;
