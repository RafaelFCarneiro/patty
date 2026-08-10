import { CurrencyCode } from '../../../models/money.js';

export const CURRENCIES = [
  { code: CurrencyCode.enum.BRL, symbol: 'R$', name: 'Real Brasileiro', decimals: 2 },
  { code: CurrencyCode.enum.USD, symbol: '$', name: 'US Dollar', decimals: 2 },
  { code: CurrencyCode.enum.USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  { code: CurrencyCode.enum.BTC, symbol: '₿', name: 'Bitcoin', decimals: 8 },
] as const satisfies ReadonlyArray<{ code: string; symbol: string; name: string; decimals: number }>;
