import { and, eq, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import * as assetAdapters from '../../../adapters/assets.js';
import type { AssetPriceEntity } from '../../../models/asset.js';
import type { Db } from '../driver.js';
import { assetPrices } from '../schema.js';
import { isUniqueConstraintViolation } from '../sqlite-errors.js';
import { VersionConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type AssetPricesRepo = {
  /** The newest price of every asset that has one. Stored `as_of` is canonical UTC, so the text order is time order. */
  latest: () => Promise<AssetPriceEntity[]>;
  /** The price recorded for an asset at an instant, with its version: a repeat price for it revises that row. */
  findAt: (assetId: string, asOf: string) => Promise<AssetPriceEntity | null>;
};

export const assetPricesRepo = (db: Db): AssetPricesRepo => ({
  latest: async () => {
    const newer = alias(assetPrices, 'newer_prices');
    const newestOfAsset = db
      .select({ asOf: max(newer.asOf) })
      .from(newer)
      .where(eq(newer.assetId, assetPrices.assetId));
    const rows = await db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.asOf, newestOfAsset))
      .orderBy(assetPrices.assetId);
    return rows.map(assetAdapters.priceDbToEntity);
  },

  findAt: async (assetId, asOf) => {
    const [row] = await db
      .select()
      .from(assetPrices)
      .where(and(eq(assetPrices.assetId, assetId), eq(assetPrices.asOf, asOf)))
      .limit(1);
    return row ? assetAdapters.priceDbToEntity(row) : null;
  },
});

const versionedAssetPriceApplier = versionedTableApplier(assetPrices);

/** `asset_prices` has the secondary `UNIQUE(asset_id, as_of)` beyond `setAssetPrices`'s own pre-check (`findAt`): a
 *  concurrent first price at the same instant races into a real unique violation. It is rethrown as `VersionConflict`,
 *  and the retry's `findAt` then sees the committed row and revises it — upsert, so both callers succeed. */
export const assetPriceApplier: EntityApplier = {
  ...versionedAssetPriceApplier,
  insert: async (tx, model) => {
    try {
      return await versionedAssetPriceApplier.insert(tx, model);
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) throw new VersionConflict();
      throw cause;
    }
  },
};
