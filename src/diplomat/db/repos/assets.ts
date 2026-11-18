import { and, eq } from 'drizzle-orm';
import * as assetAdapters from '../../../adapters/assets.js';
import type { AssetEntity } from '../../../models/investment/asset.js';
import type { Db } from '../driver.js';
import { assets } from '../schema.js';
import { uniqueViolationAsConflict, versionedTableApplier, type EntityApplier } from '../effects.js';

export type AssetsRepo = {
  list: () => Promise<AssetEntity[]>;
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

export const assetApplier: EntityApplier = uniqueViolationAsConflict(versionedTableApplier(assets));
