import { z } from 'zod';
import { AssetPriceViewSchema } from '../../models/asset.js';

/** Bulk `set_asset_prices` per-item outcome — the shape of `set_exchange_rates`: one discriminated union, `error`
 *  collapsed from `AppError` to a plain string via `formatAppError` (adapters/assets.ts). */
const BulkAssetPriceItemOut = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), price: AssetPriceViewSchema }),
  z.object({ status: z.literal('error'), asset: z.string(), error: z.string() }),
]);
export type BulkAssetPriceItemOut = z.infer<typeof BulkAssetPriceItemOut>;

export const BulkSetAssetPricesOut = z.object({ items: z.array(BulkAssetPriceItemOut) });
export type BulkSetAssetPricesOut = z.infer<typeof BulkSetAssetPricesOut>;
