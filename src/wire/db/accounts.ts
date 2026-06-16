import { z } from 'zod'

// Account row as returned by a Drizzle select (camelCase keys). Loose by design —
// domain constraints (enums, non-empty) are enforced by Account.parse downstream.
export const AccountRowSchema = z.object({
  id:             z.string(),
  name:           z.string(),
  type:           z.string(),
  initialBalance: z.number(),
  currency:       z.string(),
})

export const BalancePartsRow = z.object({
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
})
export type BalancePartsRow = z.infer<typeof BalancePartsRow>
