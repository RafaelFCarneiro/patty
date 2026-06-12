import { z } from 'zod'

export const BalancePartsRow = z.object({
  income: z.number(),
  expenses: z.number(),
  transfersIn: z.number(),
  transfersOut: z.number(),
})
export type BalancePartsRow = z.infer<typeof BalancePartsRow>
