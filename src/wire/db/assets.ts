import type { assetPrices, assets } from '../../diplomat/db/schema.js';

export type AssetRow = typeof assets.$inferSelect;
export type AssetPriceRow = typeof assetPrices.$inferSelect;
