import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import type { Ambiguous, NotFound, ValidationError } from './error.js';
import { Id } from './id.js';
import { CurrencyCode } from './money.js';

/** Entity tags for the shared reference data of ADR-038: one instrument and one price series per instance. */
export const ASSET_ENTITY_TAG = 'asset';
export const ASSET_PRICE_ENTITY_TAG = 'asset_price';

/** A price's instant: strict ISO 8601 with an offset, so it always parses and can be stored as canonical UTC (the text
 *  order of stored prices is then their time order). Exchange rates accept compact offsets too; prices never did. */
export const AssetTimestamp = z.iso.datetime({ offset: true });

export const AssetClass = z.enum(['stock', 'etf', 'reit', 'bdr', 'fixed_income']);
export type AssetClass = z.infer<typeof AssetClass>;

/** `market`: a public quote exists. `manual`: the agent posts the value itself (a CDB, a pension fund). */
export const AssetPricing = z.enum(['market', 'manual']);
export type AssetPricing = z.infer<typeof AssetPricing>;

export const AssetSchema = z.object({
  id: Id.describe('Unique asset identifier'),
  symbol: z.string().min(1).describe('Ticker or product code, e.g. NU, KNCR11, TESOURO-SELIC-2031'),
  exchange: z.string().min(1).describe('Where it is quoted, e.g. NYSE, B3; unique together with the symbol'),
  name: z.string().min(1).describe('Display name, e.g. "Nu Holdings"'),
  assetClass: AssetClass.describe('stock | etf | reit (FII) | bdr | fixed_income'),
  currency: CurrencyCode.describe('Quote currency: the price of one unit is expressed in this currency'),
  pricing: AssetPricing.describe('market (a public quote exists) | manual (the agent posts the value)'),
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetEntitySchema = withPersistenceMeta(AssetSchema);
export type AssetEntity = z.infer<typeof AssetEntitySchema>;

export const RegisterAssetSchema = AssetSchema.omit({ id: true });
export type RegisterAsset = z.infer<typeof RegisterAssetSchema>;

export const AssetPriceSchema = z.object({
  id: Id.describe('Unique asset price identifier'),
  assetId: Id.describe('The asset this price quotes'),
  price: z.number().positive().describe('Price of ONE unit in the asset currency, as of `asOf`'),
  asOf: AssetTimestamp.describe('ISO 8601 timestamp this price was observed/sourced (agent-supplied)'),
  source: z.string().min(1).nullable().describe('Free-text provenance (e.g. "B3 close"), or null if unspecified'),
});
export type AssetPrice = z.infer<typeof AssetPriceSchema>;

export const AssetPriceEntitySchema = withPersistenceMeta(AssetPriceSchema);
export type AssetPriceEntity = z.infer<typeof AssetPriceEntitySchema>;

/** Agent-supplied external data, decoded at the boundary like an exchange rate (ADR-026, ADR-038 §1). */
export const SetAssetPriceSchema = z.object({
  asset: z.string().min(1).describe('Asset symbol (e.g. "NU"), or "EXCHANGE:SYMBOL" (e.g. "NYSE:NU") when ambiguous'),
  price: z.number().positive().describe('Price of ONE unit in the asset currency, as of `asOf`'),
  asOf: AssetTimestamp.describe('ISO 8601 timestamp this price was observed/sourced'),
  source: z.string().min(1).optional().describe('Free-text provenance, e.g. "B3 close", "yahoo"'),
});
export type SetAssetPriceInput = z.infer<typeof SetAssetPriceSchema>;

export const ListAssetsSchema = z.object({
  assetClass: AssetClass.optional().describe('Only assets of this class'),
  staleOnly: z
    .boolean()
    .optional()
    .describe('Only assets whose price is missing or stale — the ones that need a refresh'),
});
export type ListAssetsInput = z.infer<typeof ListAssetsSchema>;

/** The newest price of an asset, with the flags a reader needs to trust it. */
export const AssetViewSchema = AssetSchema.extend({
  price: z.number().positive().nullable().describe('Latest price of one unit; null when none was ever posted'),
  priceAsOf: AssetTimestamp.nullable().describe('When the latest price was observed'),
  stale: z.boolean().describe('True when the latest price is older than its pricing class allows'),
  noPrice: z.boolean().describe('True when no price was ever posted'),
});
export type AssetView = z.infer<typeof AssetViewSchema>;

export const RegisterAssetResultSchema = z.object({
  asset: AssetSchema,
  created: z.boolean().describe('False when the symbol and exchange were already registered'),
  warnings: z.array(z.string()).optional().describe('Fields of the request that differ from what is registered'),
});
export type RegisterAssetResult = z.infer<typeof RegisterAssetResultSchema>;

export const AssetPriceViewSchema = z.object({
  asset: z.string().describe('EXCHANGE:SYMBOL of the priced asset'),
  price: z.number().positive(),
  asOf: AssetTimestamp,
  source: z.string().min(1).optional(),
});
export type AssetPriceView = z.infer<typeof AssetPriceViewSchema>;

export type AssetPriceBulkItem<E = unknown> =
  { status: 'ok'; price: AssetPriceView } | { status: 'error'; asset: string; error: E };

export type AssetError = NotFound<'asset'> | Ambiguous<'asset'> | ValidationError;

/** The reference a person types for an asset, split into its parts. */
export type AssetRef = { symbol: string; exchange: string | null };

/** How long a price stays fresh: market quotes in hours (a Friday close is still fresh on Monday), manual values in
 *  days (a CDB is revalued monthly). */
export type PriceStalenessThresholds = { marketHours: number; manualDays: number };
