import { z } from 'zod';
import { BillSchema } from '../../models/bill.js';
import { RawTransactionViewSchema } from '../../models/transaction.js';

export const BillViewOut = z.object({
  bill: BillSchema,
  cardName: z.string(),
  transactions: z.array(RawTransactionViewSchema),
  total: z.number(),
});
export type BillViewOut = z.infer<typeof BillViewOut>;
