import { CurrencyCode, type Currency } from '../../../src/models/money.js';

/** The seeded ADR-026 currency reference list (BRL/USD 2dp, USDC 6dp, BTC 8dp) — shared across
 *  unit tests that need `deps.currencies.list()`/`decimalsLookup` fixture data, so the decimals
 *  table lives in one place instead of drifting across per-file copies. */
export const ADR_026_CURRENCIES: Currency[] = [
  { code: CurrencyCode.enum.BRL, symbol: 'R$', name: 'Real', decimals: 2 },
  { code: CurrencyCode.enum.USD, symbol: '$', name: 'Dollar', decimals: 2 },
  { code: CurrencyCode.enum.USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  { code: CurrencyCode.enum.BTC, symbol: '₿', name: 'Bitcoin', decimals: 8 },
];
