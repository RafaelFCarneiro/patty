import { formatAppError, type AppError } from '../common/errors.js';
import { BulkItemStatus } from '../models/bulk.js';
import * as persistence from '../logic/persistence.js';
import {
  ASSET_ENTITY_TAG,
  ASSET_PRICE_ENTITY_TAG,
  AssetEntitySchema,
  AssetPriceEntitySchema,
  type AssetEntity,
  type AssetPriceBulkItem,
  type AssetPriceEntity,
} from '../models/investment/asset.js';
import type { AssetPriceRow, AssetRow } from '../wire/db/assets.js';
import { BulkSetAssetPricesOut, type BulkAssetPriceItemOut } from '../wire/out/assets.js';

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

export const priceDbToEntity = (row: AssetPriceRow): AssetPriceEntity =>
  AssetPriceEntitySchema.parse({
    id: row.id,
    assetId: row.assetId,
    price: row.price,
    asOf: row.asOf,
    source: row.source,
    version: row.version,
  });

export const priceModelToDb = (entity: AssetPriceEntity): AssetPriceRow => entity;

const assetAdapter = persistence.entityDbAdapter(ASSET_ENTITY_TAG, modelToDb);
const priceAdapter = persistence.entityDbAdapter(ASSET_PRICE_ENTITY_TAG, priceModelToDb);

export const { persistableToDb, outcomeToDb } = assetAdapter;
export const { persistableToDb: pricePersistableToDb, outcomeToDb: priceOutcomeToDb } = priceAdapter;

const bulkItemToWireOut = (item: AssetPriceBulkItem<AppError>): BulkAssetPriceItemOut =>
  item.status === BulkItemStatus.enum.error
    ? { status: BulkItemStatus.enum.error, asset: item.asset, error: formatAppError(item.error) }
    : item;

export const bulkResultToWireOut = (items: AssetPriceBulkItem<AppError>[]): BulkSetAssetPricesOut =>
  BulkSetAssetPricesOut.parse({ items: items.map(bulkItemToWireOut) });
