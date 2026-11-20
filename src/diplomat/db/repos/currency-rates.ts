import { and, eq } from 'drizzle-orm';
import * as currencyRateAdapters from '../../../adapters/currency-rates.js';
import type { CurrencyRateEntity } from '../../../models/currency-rate.js';
import type { CurrencyCode } from '../../../models/money.js';
import type { Db } from '../driver.js';
import { currencyRates } from '../schema.js';
import { uniqueViolationAsConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type CurrencyRatesRepo = {
  /** Every stored rate — no spend/balance correlation here; that's a controller's job (ADR-028), a
   *  Phase 3 concern once a valuation consumer exists. */
  list: () => Promise<CurrencyRateEntity[]>;
  /** Version-carrying read for `setExchangeRate`'s upsert-latest decision (current ? update : insert). */
  findByPair: (from: CurrencyCode, to: CurrencyCode) => Promise<CurrencyRateEntity | null>;
};

const list = async (db: Db): ReturnType<CurrencyRatesRepo['list']> => {
  const rows = await db.select().from(currencyRates).orderBy(currencyRates.fromCode, currencyRates.toCode);
  return rows.map(currencyRateAdapters.dbToEntity);
};

const findByPair = async (
  db: Db,
  from: CurrencyCode,
  to: CurrencyCode,
): ReturnType<CurrencyRatesRepo['findByPair']> => {
  const [row] = await db
    .select()
    .from(currencyRates)
    .where(and(eq(currencyRates.fromCode, from), eq(currencyRates.toCode, to)))
    .limit(1);
  return row ? currencyRateAdapters.dbToEntity(row) : null;
};

export const currencyRatesRepo = (db: Db): CurrencyRatesRepo => ({
  list: () => list(db),
  findByPair: (from, to) => findByPair(db, from, to),
});

export const currencyRateApplier: EntityApplier = uniqueViolationAsConflict(versionedTableApplier(currencyRates));
