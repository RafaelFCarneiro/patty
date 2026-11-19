import { z } from 'zod';
import { SetAssetPriceSchema } from '../../models/investment/asset.js';

const MAX_BULK_ASSET_PRICES = 100;

export const SetAssetPricesSchema = z.object({
  prices: z.array(SetAssetPriceSchema).min(1).max(MAX_BULK_ASSET_PRICES),
});
export type SetAssetPrices = z.infer<typeof SetAssetPricesSchema>;
