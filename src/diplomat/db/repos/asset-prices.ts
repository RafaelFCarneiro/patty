import { and, eq, max } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import * as assetPriceAdapters from '../../../adapters/asset-prices.js';
import type { AssetPriceEntity } from '../../../models/investment/asset.js';
import type { Db } from '../driver.js';
import { assetPrices } from '../schema.js';
import { uniqueViolationAsConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type AssetPricesRepo = {
  latest: () => Promise<AssetPriceEntity[]>;
  findAt: (assetId: string, asOf: string) => Promise<AssetPriceEntity | null>;
};

const latest = async (db: Db): ReturnType<AssetPricesRepo['latest']> => {
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
  return rows.map(assetPriceAdapters.dbToEntity);
};

const findAt = async (db: Db, assetId: string, asOf: string): ReturnType<AssetPricesRepo['findAt']> => {
  const [row] = await db
    .select()
    .from(assetPrices)
    .where(and(eq(assetPrices.assetId, assetId), eq(assetPrices.asOf, asOf)))
    .limit(1);
  return row ? assetPriceAdapters.dbToEntity(row) : null;
};

export const assetPricesRepo = (db: Db): AssetPricesRepo => ({
  latest: () => latest(db),
  findAt: (assetId, asOf) => findAt(db, assetId, asOf),
});

export const assetPriceApplier: EntityApplier = uniqueViolationAsConflict(versionedTableApplier(assetPrices));
