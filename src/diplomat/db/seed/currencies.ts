import { CurrencyCode } from '../../../models/money.js'

export const CURRENCIES = [
  { code: CurrencyCode.enum.BRL, symbol: 'R$', name: 'Real Brasileiro' },
  { code: CurrencyCode.enum.USD, symbol: '$',  name: 'US Dollar' },
] as const satisfies ReadonlyArray<{ code: string; symbol: string; name: string }>
