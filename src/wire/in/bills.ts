import { z } from 'zod'

export const BillQuery = z.object({
  card: z.string().min(1),
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
})
export type BillQuery = z.infer<typeof BillQuery>

export const PayBillInput = BillQuery.extend({
  account: z.string().optional(),
})
export type PayBillInput = z.infer<typeof PayBillInput>
