import { and, eq } from 'drizzle-orm';
import * as currencyRateAdapters from '../../../adapters/currency-rates.js';
import type { CurrencyRateEntity } from '../../../models/currency-rate.js';
import type { CurrencyCode } from '../../../models/money.js';
import type { Db } from '../driver.js';
import { currencyRates } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqlite-errors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type CurrencyRatesRepo = {
  /** Every stored rate — no spend/balance correlation here; that's a controller's job (ADR-028), a
   *  Phase 3 concern once a valuation consumer exists. */
  list: () => Promise<CurrencyRateEntity[]>;
  /** Version-carrying read for `setExchangeRate`'s upsert-latest decision (current ? update : insert). */
  findByPair: (from: CurrencyCode, to: CurrencyCode) => Promise<CurrencyRateEntity | null>;
};

export const currencyRatesRepo = (db: Db): CurrencyRatesRepo => ({
  list: async () => {
    const rows = await db.select().from(currencyRates).orderBy(currencyRates.fromCode, currencyRates.toCode);
    return rows.map(currencyRateAdapters.dbToEntity);
  },

  findByPair: async (from, to) => {
    const [row] = await db
      .select()
      .from(currencyRates)
      .where(and(eq(currencyRates.fromCode, from), eq(currencyRates.toCode, to)))
      .limit(1);
    return row ? currencyRateAdapters.dbToEntity(row) : null;
  },
});

const versionedCurrencyRateApplier = versionedTableApplier(currencyRates);

/** `currency_rates` has the secondary `UNIQUE(from_code, to_code)` beyond `setExchangeRate`'s own
 *  pre-check (`findByPair`) — a concurrent upsert of the same pair races into a real
 *  `SQLITE_CONSTRAINT_UNIQUE` the id-scoped `onConflictDoNothing` doesn't swallow. Recognized and
 *  rethrown as `VersionConflict`, rolling back and retrying — the retry's own `findByPair` then
 *  sees the committed row and applies as an update instead of a duplicate insert (upsert-latest,
 *  ADR-026). Structurally identical to `budgetApplier` (`diplomat/db/repos/budgets.ts`), except a
 *  resolved "duplicate" here is never an error — it's the intended upsert-latest outcome. */
export const currencyRateApplier: EntityApplier = {
  ...versionedCurrencyRateApplier,
  insert: async (tx, model) => {
    try {
      return await versionedCurrencyRateApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
