import { z } from 'zod';

/** The per-item verdict of a bulk call with partial success (`set_exchange_rates`, `set_asset_prices`). */
export const BulkItemStatus = z.enum(['ok', 'error']);
export type BulkItemStatus = z.infer<typeof BulkItemStatus>;
