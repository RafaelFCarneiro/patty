import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import { CurrencyRateViewSchema } from '../../models/currency-rate.js';

/** Bulk `set_exchange_rates` per-item outcome — mirrors `wire/out/transactions.ts`'s `BulkItemOut`
 *  shape: one discriminated union, `error` collapsed from `AppError` to a plain string via
 *  `formatAppError` (adapters/currency-rates.ts), safe for external consumers. */
const BulkExchangeRateItemOut = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), rate: CurrencyRateViewSchema }),
  z.object({ status: z.literal('error'), from: CurrencyCode, to: CurrencyCode, error: z.string() }),
]);
export type BulkExchangeRateItemOut = z.infer<typeof BulkExchangeRateItemOut>;

export const BulkSetExchangeRatesOut = z.object({ items: z.array(BulkExchangeRateItemOut) });
export type BulkSetExchangeRatesOut = z.infer<typeof BulkSetExchangeRatesOut>;
