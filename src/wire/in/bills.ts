import { z } from 'zod'
import { BillQuerySchema, PayBillSchema } from '../../models/bill.js'

const coerceToNumber = (v: unknown) => (typeof v === 'string' ? Number(v) : v)

export const BillQuery = BillQuerySchema.extend({
  month: z.preprocess(coerceToNumber, BillQuerySchema.shape.month),
  year: z.preprocess(coerceToNumber, BillQuerySchema.shape.year),
})
export type BillQuery = z.infer<typeof BillQuery>

export const PayBill = BillQuery.extend({
  account: PayBillSchema.shape.account,
})
export type PayBill = z.infer<typeof PayBill>
