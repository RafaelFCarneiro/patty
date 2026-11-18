import { z } from 'zod';
import { BulkItemStatus } from '../../models/bulk.js';
import { AssetPriceViewSchema } from '../../models/investment/asset.js';

const BulkAssetPriceItemOut = z.discriminatedUnion('status', [
  z.object({ status: z.literal(BulkItemStatus.enum.ok), price: AssetPriceViewSchema }),
  z.object({ status: z.literal(BulkItemStatus.enum.error), asset: z.string(), error: z.string() }),
]);
export type BulkAssetPriceItemOut = z.infer<typeof BulkAssetPriceItemOut>;

export const BulkSetAssetPricesOut = z.object({ items: z.array(BulkAssetPriceItemOut) });
export type BulkSetAssetPricesOut = z.infer<typeof BulkSetAssetPricesOut>;
