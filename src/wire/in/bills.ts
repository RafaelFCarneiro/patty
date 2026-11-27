import { z } from 'zod';
import { BillQuerySchema, PayBillSchema, RevertBillPaymentSchema } from '../../models/bill.js';
import { coerceToNumber } from './coerce.js';

export const BillQuery = BillQuerySchema.extend({
  month: z.preprocess(coerceToNumber, BillQuerySchema.shape.month),
  year: z.preprocess(coerceToNumber, BillQuerySchema.shape.year),
});
export type BillQuery = z.infer<typeof BillQuery>;

export const PayBill = BillQuery.extend({
  amount: PayBillSchema.shape.amount,
  account: PayBillSchema.shape.account,
  paymentDate: PayBillSchema.shape.paymentDate,
  discriminator: PayBillSchema.shape.discriminator,
});
export type PayBill = z.infer<typeof PayBill>;

export const RevertBillPayment = BillQuery.extend({ paymentId: RevertBillPaymentSchema.shape.paymentId });
export type RevertBillPayment = z.infer<typeof RevertBillPayment>;
