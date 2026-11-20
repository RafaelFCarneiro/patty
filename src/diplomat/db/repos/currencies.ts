import * as currencyAdapters from '../../../adapters/currencies.js';
import type { Currency } from '../../../models/money.js';
import type { Db } from '../driver.js';
import { currencies } from '../schema.js';

export type CurrenciesRepo = {
  list: () => Promise<Currency[]>;
};

const list = async (db: Db): ReturnType<CurrenciesRepo['list']> => {
  const rows = await db.select().from(currencies).orderBy(currencies.code);
  return rows.map(currencyAdapters.dbToModel);
};

export const currenciesRepo = (db: Db): CurrenciesRepo => ({
  list: () => list(db),
});
