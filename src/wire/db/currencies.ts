import type { currencies } from '../../diplomat/db/schema.js';

// Currency row from a Drizzle select — derived from schema.ts (single source of truth).
export type CurrencyRow = typeof currencies.$inferSelect;
