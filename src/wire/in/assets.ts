import { z } from 'zod';
import { SetAssetPriceSchema } from '../../models/asset.js';

// Caps a single bulk call — an agent refreshing quotes after a web pull touches a portfolio's worth of assets, never
// thousands; keeps one call bounded rather than an unbounded array.
const MAX_BULK_ASSET_PRICES = 100;

export const SetAssetPricesSchema = z.object({
  prices: z.array(SetAssetPriceSchema).min(1).max(MAX_BULK_ASSET_PRICES),
});
export type SetAssetPrices = z.infer<typeof SetAssetPricesSchema>;
