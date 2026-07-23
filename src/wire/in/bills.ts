import { z } from 'zod';
import { BillQuerySchema, PayBillSchema } from '../../models/bill.js';
import { coerceToNumber } from './coerce.js';

export const BillQuery = BillQuerySchema.extend({
  month: z.preprocess(coerceToNumber, BillQuerySchema.shape.month),
  year: z.preprocess(coerceToNumber, BillQuerySchema.shape.year),
});
export type BillQuery = z.infer<typeof BillQuery>;

export const PayBill = BillQuery.extend({
  account: PayBillSchema.shape.account,
  paymentDate: PayBillSchema.shape.paymentDate,
});
export type PayBill = z.infer<typeof PayBill>;
