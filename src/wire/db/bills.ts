import { z } from 'zod';

// Bill row from the raw SELECT (snake_case). Loose; BillSchema.parse enforces the status
// enum and date formats downstream. Joined columns (e.g. card_name) are read separately.
export const BillRowSchema = z.object({
  id: z.string(),
  credit_card_id: z.string(),
  month: z.number(),
  year: z.number(),
  close_date: z.string(),
  due_date: z.string(),
  status: z.string(),
  payment_transaction_id: z.string().nullable(),
  version: z.number(),
});
