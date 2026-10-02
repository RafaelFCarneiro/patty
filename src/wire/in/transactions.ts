import { z } from 'zod';
import { INCLUDE_TOTAL_DESCRIPTION, SortDirection } from '../../models/page.js';
import * as modelTransaction from '../../models/transaction.js';
import { SearchTransactionsSchema, TransactionSortField } from '../../models/transaction.js';
import type { SearchTransactions } from '../../models/transaction.js';
import { BooleanQuerySchema } from './common.js';
import { coerceToNumber } from './coerce.js';

// Wire input schemas — derived from model schemas.
// Boundary-only behavior (limit default) stays here; everything else is pass-through.

// Pass-through — no boundary-only defaults needed.
export const ConfirmTransactionSchema = modelTransaction.ConfirmTransactionSchema;
export type ConfirmTransaction = z.infer<typeof ConfirmTransactionSchema>;

// Pre-transform query shape — a plain ZodObject, so it can also serve as the route's
// OpenAPI query schema (routes.ts), which needs a ZodObject rather than the ZodEffects
// that .transform() produces below. QoL defaults (limit → 50, sort → date, dir → desc) are
// applied by the transform below, per the defaults-by-intent rule (domain stays honest about
// what's genuinely required). `includeTotal` arrives as a query string, not a real boolean.
export const SearchTransactionsQuerySchema = SearchTransactionsSchema.extend({
  // A query string never carries a real number — coerce, like CoercedPeriodSchema (wire/in/period.js).
  month: z.preprocess(coerceToNumber, SearchTransactionsSchema.shape.month),
  year: z.preprocess(coerceToNumber, SearchTransactionsSchema.shape.year),
  limit: z.preprocess(coerceToNumber, SearchTransactionsSchema.shape.limit).optional(),
  sort: SearchTransactionsSchema.shape.sort.optional(),
  dir: SearchTransactionsSchema.shape.dir.optional(),
  includeTotal: BooleanQuerySchema.optional().describe(INCLUDE_TOTAL_DESCRIPTION),
});

export const SearchTransactionsInputSchema = SearchTransactionsQuerySchema.transform((input): SearchTransactions => ({
  ...input,
  limit: input.limit ?? 50,
  sort: input.sort ?? TransactionSortField.enum.date,
  dir: input.dir ?? SortDirection.enum.desc,
  includeTotal: input.includeTotal === 'true',
}));
export type SearchTransactionsInput = z.output<typeof SearchTransactionsInputSchema>;
