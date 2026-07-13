import { z } from 'zod';
import type { accounts } from '../../diplomat/db/schema.js';

// Account row from a Drizzle select — derived from schema.ts, the single source of truth. Also
// what adapters/accounts.ts's modelToDb produces for the versioned unit of work (ADR-021): every
// field, including `version`, is always populated, so the select (fully-required) shape — not
// drizzle's insert-side type, which marks `.default(...)` columns optional — is the accurate one.
export type AccountRow = typeof accounts.$inferSelect;

export const BalancePartsRow = z.object({
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
});
export type BalancePartsRow = z.infer<typeof BalancePartsRow>;
