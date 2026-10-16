import { z } from 'zod';
import type { recurringRules } from '../../diplomat/db/schema.js';
import type { WithoutOwner } from './tenancy.js';

// Recurring-rule row from the raw SELECT (snake_case + joined account/category names).
// Loose; RecurringRuleViewSchema.parse/RecurringRuleEntitySchema.parse enforce enums and date
// formats downstream.
export const RecurringRowSchema = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.number(),
  type: z.string(),
  period: z.string(),
  next_due: z.string(),
  currency: z.string(),
  account_id: z.string().nullable(),
  account_name: z.string().nullable(),
  category_id: z.string().nullable(),
  category_name: z.string().nullable(),
  merchant_key: z.string().nullable(),
  version: z.number().int(),
});

// What adapters/recurring.ts's modelToDb produces for the versioned unit of work (ADR-021) —
// mirrors wire/db/accounts.ts's AccountRow.
export type RecurringRuleRow = WithoutOwner<typeof recurringRules.$inferSelect>;
