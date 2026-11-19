import { formatAppError, type AppError } from '../common/errors.js';
import * as persistence from '../logic/persistence.js';
import { BulkItemStatus } from '../models/bulk.js';
import {
  ASSET_PRICE_ENTITY_TAG,
  AssetPriceEntitySchema,
  type AssetPriceBulkItem,
  type AssetPriceEntity,
} from '../models/investment/asset.js';
import type { AssetPriceRow } from '../wire/db/assets.js';
import { BulkSetAssetPricesOut, type BulkAssetPriceItemOut } from '../wire/out/assets.js';

export const dbToEntity = (row: AssetPriceRow): AssetPriceEntity =>
  AssetPriceEntitySchema.parse({
    id: row.id,
    assetId: row.assetId,
    price: row.price,
    asOf: row.asOf,
    source: row.source,
    version: row.version,
  });

export const modelToDb = (entity: AssetPriceEntity): AssetPriceRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(ASSET_PRICE_ENTITY_TAG, modelToDb);

const bulkItemToWireOut = (item: AssetPriceBulkItem<AppError>): BulkAssetPriceItemOut =>
  item.status === BulkItemStatus.enum.error
    ? { status: BulkItemStatus.enum.error, asset: item.asset, error: formatAppError(item.error) }
    : item;

export const bulkResultToWireOut = (items: AssetPriceBulkItem<AppError>[]): BulkSetAssetPricesOut =>
  BulkSetAssetPricesOut.parse({ items: items.map(bulkItemToWireOut) });
