import { z } from 'zod';

export const CurrencyCode = z.enum(['USD', 'BRL', 'USDC', 'BTC']);
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.number().positive();

// Reference metadata for a currency (ADR-026 Phase 1) — lets a client format a non-ISO code
// (USDC/BTC) that `Intl.NumberFormat`'s currency mode rejects, via symbol + decimals instead.
export const CurrencySchema = z.object({
  code: CurrencyCode.describe('ISO 4217 code for fiat, a local convention for crypto (USDC/BTC)'),
  symbol: z.string().min(1).describe('Display symbol (e.g. R$, $, ₿)'),
  name: z.string().min(1).describe('Display name'),
  decimals: z.number().int().nonnegative().describe('Fractional digits for display/rounding'),
});
export type Currency = z.infer<typeof CurrencySchema>;
