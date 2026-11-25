import { z } from 'zod';
import { SettledBillSchema } from '../../models/bill.js';
import { RawTransactionViewSchema } from '../../models/transaction.js';

export const BillViewOut = z.object({
  bill: SettledBillSchema,
  cardName: z.string(),
  transactions: z.array(RawTransactionViewSchema),
  total: z.number(),
});
export type BillViewOut = z.infer<typeof BillViewOut>;
