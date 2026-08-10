import { CurrencySchema, type Currency } from '../models/money.js';
import type { CurrencyRow } from '../wire/db/currencies.js';

export const dbToModel = (row: CurrencyRow): Currency =>
  CurrencySchema.parse({ code: row.code, symbol: row.symbol, name: row.name, decimals: row.decimals });
