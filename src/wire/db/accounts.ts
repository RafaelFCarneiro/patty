import { z } from 'zod'
import type { accounts } from '../../diplomat/db/schema.js'

// Account row from a Drizzle select — derived from schema.ts, the single source of truth.
export type AccountRow = typeof accounts.$inferSelect

export const BalancePartsRow = z.object({
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
})
export type BalancePartsRow = z.infer<typeof BalancePartsRow>
