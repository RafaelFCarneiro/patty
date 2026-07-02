import { z } from 'zod';
import { TransactionViewSchema } from '../../models/transaction.js';

export const ApplyDueResultOut = z.object({
  applied: z.array(z.object({ rule: z.string(), date: z.string(), transaction: TransactionViewSchema })),
  count: z.number().int(),
});
export type ApplyDueResultOut = z.infer<typeof ApplyDueResultOut>;
