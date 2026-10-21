import type { currencyRates } from '../../diplomat/db/schema.js';

// Currency rate row from a Drizzle select — derived from schema.ts (single source of truth).
export type CurrencyRateRow = typeof currencyRates.$inferSelect;
