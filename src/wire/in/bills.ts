import { z } from 'zod'
import { BillQuerySchema, PayBillSchema } from '../../models/bill.js'

export const BillQuery = BillQuerySchema.extend({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
})
export type BillQuery = z.infer<typeof BillQuery>

export const PayBill = BillQuery.extend({
  account: PayBillSchema.shape.account,
})
export type PayBill = z.infer<typeof PayBill>
