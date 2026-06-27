import { z } from 'zod'

// Recurring-rule row from the raw SELECT (snake_case + joined account/category names).
// Loose; RecurringRuleViewSchema.parse enforces enums and date formats downstream.
export const RecurringRowSchema = z.object({
  id:            z.string(),
  description:   z.string(),
  amount:        z.number(),
  type:          z.string(),
  period:        z.string(),
  next_due:      z.string(),
  currency:      z.string(),
  account_id:    z.string().nullable(),
  account_name:  z.string().nullable(),
  category_id:   z.string().nullable(),
  category_name: z.string().nullable(),
})
