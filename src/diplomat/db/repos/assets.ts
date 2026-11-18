import { and, eq } from 'drizzle-orm';
import * as assetAdapters from '../../../adapters/assets.js';
import type { AssetEntity } from '../../../models/asset.js';
import type { Db } from '../driver.js';
import { assets } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqlite-errors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type AssetsRepo = {
  /** Every registered asset — shared reference data, the same for every user. */
  list: () => Promise<AssetEntity[]>;
  /** Version-carrying read for `registerAsset`'s idempotent decision (existing ? keep or rename : insert). */
  findByKey: (symbol: string, exchange: string) => Promise<AssetEntity | null>;
};

export const assetsRepo = (db: Db): AssetsRepo => ({
  list: async () => {
    const rows = await db.select().from(assets).orderBy(assets.exchange, assets.symbol);
    return rows.map(assetAdapters.dbToEntity);
  },

  findByKey: async (symbol, exchange) => {
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.symbol, symbol), eq(assets.exchange, exchange)))
      .limit(1);
    return row ? assetAdapters.dbToEntity(row) : null;
  },
});

const versionedAssetApplier = versionedTableApplier(assets);

/** `assets` has the secondary `UNIQUE(symbol, exchange)` beyond `registerAsset`'s own pre-check (`findByKey`): two
 *  callers registering the same new asset at once race into a real `SQLITE_CONSTRAINT_UNIQUE` the id-scoped
 *  `onConflictDoNothing` doesn't swallow. It is rethrown as `VersionConflict`, so the loser's retry re-reads, finds the
 *  winner's row and answers "already registered" (the same treatment as `currencyRateApplier`). */
export const assetApplier: EntityApplier = {
  ...versionedAssetApplier,
  insert: async (tx, model) => {
    try {
      return await versionedAssetApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
