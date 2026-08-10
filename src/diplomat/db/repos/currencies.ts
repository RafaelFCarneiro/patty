import * as currencyAdapters from '../../../adapters/currencies.js';
import type { Currency } from '../../../models/money.js';
import type { Db } from '../driver.js';
import { currencies } from '../schema.js';

export type CurrenciesRepo = {
  list: () => Promise<Currency[]>;
};

export const currenciesRepo = (db: Db): CurrenciesRepo => ({
  list: async () => {
    const rows = await db.select().from(currencies).orderBy(currencies.code);
    return rows.map(currencyAdapters.dbToModel);
  },
});
