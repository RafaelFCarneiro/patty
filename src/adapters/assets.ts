import * as persistence from '../logic/persistence.js';
import { ASSET_ENTITY_TAG, AssetEntitySchema, type AssetEntity } from '../models/investment/asset.js';
import type { AssetRow } from '../wire/db/assets.js';

export const dbToEntity = (row: AssetRow): AssetEntity =>
  AssetEntitySchema.parse({
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    name: row.name,
    assetClass: row.assetClass,
    currency: row.currency,
    pricing: row.pricing,
    version: row.version,
  });

export const modelToDb = (entity: AssetEntity): AssetRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(ASSET_ENTITY_TAG, modelToDb);
