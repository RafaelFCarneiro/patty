import { z } from 'zod';

export const CurrencyCode = z.enum(['USD', 'BRL', 'USDC', 'BTC']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.number().positive();

/** A currency's own fractional digits (BRL/USD 2, USDC 6, BTC 8 — ADR-026) — rounding a total to a
 *  flat 2 decimals would corrupt a native BTC/USDC amount. */
export type DecimalsFor = (currency: CurrencyCode) => number;

// Reference metadata for a currency (ADR-026 Phase 1) — lets a client format a code
// `Intl.NumberFormat`'s currency mode can't handle correctly (USDC throws — 4 letters fail its
// syntax check; BTC doesn't throw — 3 letters pass, but it silently mis-formats with fiat-shaped
// precision and no real symbol) via this currency's own symbol + decimals instead.
export const CurrencySchema = z.object({
  code: CurrencyCode.describe('ISO 4217 code for fiat, a local convention for crypto (USDC/BTC)'),
  symbol: z.string().min(1).describe('Display symbol (e.g. R$, $, ₿)'),
  name: z.string().min(1).describe('Display name'),
  decimals: z.number().int().nonnegative().describe('Fractional digits for display/rounding'),
});
export type Currency = z.infer<typeof CurrencySchema>;
