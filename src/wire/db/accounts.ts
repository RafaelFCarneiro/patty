import { z } from 'zod';
import type { accounts } from '../../diplomat/db/schema.js';

// Account row from a Drizzle select — derived from schema.ts, the single source of truth.
export type AccountRow = typeof accounts.$inferSelect;
// Account row shape for insert/update (drizzle's insert-side type) — used by the versioned unit
// of work applier (ADR-021), which writes the full row including `version`.
export type AccountInsertRow = typeof accounts.$inferInsert;

export const BalancePartsRow = z.object({
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
});
export type BalancePartsRow = z.infer<typeof BalancePartsRow>;
