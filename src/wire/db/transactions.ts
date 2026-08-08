import { z } from 'zod';
import { CurrencyCode } from '../../models/money.js';
import { MovementType, TransactionSortField, TransactionStatus } from '../../models/transaction.js';
import type { transactions } from '../../diplomat/db/schema.js';
import { parseCategoryNames } from './categories.js';

// Inferred Drizzle select type — the canonical shape of a transactions row.
export type TransactionRow = typeof transactions.$inferSelect;

// The columns dbToModel consumes from the full transaction SELECT (node columns +
// LEFT JOINed related names/tags). Decoded at the boundary before mapping to the model;
// unrelated columns the SELECT may also return are ignored by z.object.
export const TransactionRowSchema = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.number(),
  type: z.string(),
  status: TransactionStatus,
  date: z.string(),
  currency: z.string(),
  source: z.string(),
  idempotency_key: z.string(),
  classification_method: z.string(),
  confidence: z.number(),
  raw_input: z.string().nullable(),
  note: z.string().nullable(),
  from_account_id: z.string().nullable(),
  from_account_name: z.string().nullable(),
  to_account_id: z.string().nullable(),
  to_account_name: z.string().nullable(),
  credit_card_id: z.string().nullable(),
  credit_card_name: z.string().nullable(),
  bill_id: z.string().nullable(),
  category_id: z.string().nullable(),
  category_name: z.string().nullable(),
  category_names: z.string().nullable().default(null),
  subcategory_id: z.string().nullable(),
  subcategory_name: z.string().nullable(),
  subcategory_names: z.string().nullable().default(null),
  merchant_key: z.string().nullable(),
  tags: z.string().nullable(), // JSON array from json_group_array
  version: z.number().int().nonnegative(),
});

// Flat node properties handed to the INSERT. `type` is derived from the Drizzle schema
// so the repo never casts the string into the column's enum union.
export type TransactionDbProps = {
  id: string;
  description: string;
  amount: number;
  type: TransactionRow['type'];
  status: TransactionRow['status'];
  date: string;
  currency: string;
  source: TransactionRow['source'];
  idempotencyKey: string;
  classificationMethod: TransactionRow['classificationMethod'];
  confidence: number;
  rawInput: string | null;
  note: string | null;
};

export type TransactionDbRefs = {
  accountId: string | null;
  toAccountId: string | null;
  cardId: string | null;
  billId: string | null;
  categoryId: string | null;
  subCategoryId: string | null;
  merchantKey: string | null;
};

/**
 * ADR-011/014 whitelist: the only column each `search_transactions` sort field may resolve to.
 * The caller-selected `sort` enum picks a fixed, developer-authored column name here — caller
 * text never reaches `ORDER BY`. Plain db-column facts (this file's existing job — see
 * `TransactionRowSchema`), not query composition: `diplomat/db/repos/transactions.ts` is the only
 * place that turns a name from this map into an actual SQL fragment (`sql.raw`).
 */
export const ORDER_BY_COLUMN: Record<TransactionSortField, string> = {
  [TransactionSortField.enum.date]: 't.date',
  [TransactionSortField.enum.amount]: 't.amount',
};

export const SummaryRowSchema = z
  .object({
    currency: CurrencyCode,
    type: MovementType,
    category: z.string().nullable(),
    category_names: z.string().nullable().default(null),
    total: z.number(),
    count: z.number(),
  })
  .transform(({ category_names, ...rest }) => ({
    ...rest,
    categoryNames: parseCategoryNames(category_names),
  }));

export const CategorySpendRowSchema = z
  .object({
    currency: CurrencyCode,
    category_id: z.string(),
    subcategory_id: z.string().nullable(),
    effective: z.number(),
    pending: z.number(),
  })
  .transform(({ category_id, subcategory_id, ...rest }) => ({
    ...rest,
    categoryId: category_id,
    subCategoryId: subcategory_id,
  }));
