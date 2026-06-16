import type { creditCards } from '../../diplomat/db/schema.js'

// Credit-card row from a Drizzle select — derived from schema.ts (single source of truth).
export type CreditCardRow = typeof creditCards.$inferSelect
