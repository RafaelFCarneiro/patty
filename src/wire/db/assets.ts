import type { assetPrices, assets } from '../../diplomat/db/schema.js';

// Asset and price rows from a Drizzle select — derived from schema.ts (single source of truth).
export type AssetRow = typeof assets.$inferSelect;
export type AssetPriceRow = typeof assetPrices.$inferSelect;
