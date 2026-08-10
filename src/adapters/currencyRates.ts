import { formatAppError, type AppError } from '../common/errors.js';
import type { CurrencyRateBulkItem } from '../logic/currencyRate.js';
import { CURRENCY_RATE_ENTITY_TAG, CurrencyRateEntitySchema, type CurrencyRateEntity } from '../models/currencyRate.js';
import * as persistence from '../logic/persistence.js';
import { BulkSetExchangeRatesOut, type BulkExchangeRateItemOut } from '../wire/out/currencyRates.js';
import type { CurrencyRateRow } from '../wire/db/currencyRates.js';

export const dbToEntity = (row: CurrencyRateRow): CurrencyRateEntity =>
  CurrencyRateEntitySchema.parse({
    id: row.id,
    fromCode: row.fromCode,
    toCode: row.toCode,
    rate: row.rate,
    asOf: row.asOf,
    source: row.source,
    version: row.version,
  });

// Identity: a versioned CurrencyRateEntity is already row-shaped.
export const modelToDb = (entity: CurrencyRateEntity): CurrencyRateRow => entity;

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(CURRENCY_RATE_ENTITY_TAG, modelToDb);

const bulkItemToWireOut = (item: CurrencyRateBulkItem<AppError>): BulkExchangeRateItemOut =>
  item.status === 'error' ? { status: 'error', from: item.from, to: item.to, error: formatAppError(item.error) } : item;

export const bulkResultToWireOut = (items: CurrencyRateBulkItem<AppError>[]): BulkSetExchangeRatesOut =>
  BulkSetExchangeRatesOut.parse({ items: items.map(bulkItemToWireOut) });
