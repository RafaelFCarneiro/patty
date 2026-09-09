import {
  RawTransactionViewSchema,
  TRANSACTION_ENTITY_TAG,
  type RawTransactionView,
  type Transaction,
  type TransactionEntity,
} from '../models/transaction.js';
import { LocalizedNamesSchema } from '../models/category.js';
import type {
  ClassifiedUpsertResult,
  ConfirmTransaction,
  DeleteTransactionResult,
  SearchTransactions,
} from '../models/transaction.js';
import type { BulkItemResult } from '../logic/transaction.js';
import type { AppError } from '../common/errors.js';
import * as persistence from '../logic/persistence.js';
import { TransactionRowSchema, type TransactionDbProps, type TransactionDbRefs } from '../wire/db/transactions.js';
import type * as wireIn from '../wire/in/transactions.js';
import type { BulkItemOut } from '../wire/out/transactions.js';
import { BulkResultOut, CreateTransactionOut, DeleteTransactionOut } from '../wire/out/transactions.js';
import { formatAppError } from '../common/errors.js';
import type { BulkResult } from '../logic/transaction.js';

/** db→model: decode a flat SQL row (from a full transaction SELECT) into a RawTransactionView. */
export const dbToModel = (record: Record<string, unknown>): RawTransactionView => {
  // Decode the raw row at the boundary; downstream mapping then trusts the typed shape.
  const row = TransactionRowSchema.parse(record);

  const parsedTags = row.tags ? (JSON.parse(row.tags) as unknown[]) : [];
  const tags = parsedTags.filter((tag): tag is string => typeof tag === 'string');
  const categoryNames = row.category_names !== null ? LocalizedNamesSchema.parse(JSON.parse(row.category_names)) : null;
  const subCategoryNames =
    row.subcategory_names !== null ? LocalizedNamesSchema.parse(JSON.parse(row.subcategory_names)) : null;

  return RawTransactionViewSchema.parse({
    id: row.id,
    description: row.description,
    amount: row.amount,
    type: row.type,
    status: row.status,
    date: row.date,
    currency: row.currency,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    classification: {
      method: row.classification_method,
      confidence: row.confidence,
    },
    rawInput: row.raw_input ?? undefined,
    note: row.note ?? undefined,
    accountId: row.from_account_id ?? undefined,
    accountName: row.from_account_name ?? undefined,
    toAccountId: row.to_account_id ?? undefined,
    toAccountName: row.to_account_name ?? undefined,
    cardId: row.credit_card_id ?? undefined,
    cardName: row.credit_card_name ?? undefined,
    billId: row.bill_id ?? undefined,
    categoryId: row.category_id ?? undefined,
    categoryName: row.category_name ?? undefined,
    categoryNames,
    subCategoryId: row.subcategory_id ?? undefined,
    subCategoryName: row.subcategory_name ?? undefined,
    subCategoryNames,
    merchant: row.merchant_key ?? undefined,
    tags,
    version: row.version,
  });
};

/** model→db: flatten a domain Transaction entity into node properties + edge refs. */
export const modelToDb = (entity: Transaction): { props: TransactionDbProps; refs: TransactionDbRefs } => ({
  props: {
    id: entity.id,
    description: entity.description,
    amount: entity.amount,
    type: entity.type,
    status: entity.status,
    date: entity.date,
    currency: entity.currency,
    source: entity.source,
    classificationMethod: entity.classification.method,
    confidence: entity.classification.confidence,
    rawInput: entity.rawInput ?? null,
    note: entity.note ?? null,
  },
  refs: {
    accountId: entity.refs.accountId ?? null,
    toAccountId: entity.refs.toAccountId ?? null,
    cardId: entity.refs.cardId ?? null,
    billId: entity.refs.billId ?? null,
    categoryId: entity.refs.categoryId ?? null,
    subCategoryId: entity.refs.subCategoryId ?? null,
    merchantKey: entity.refs.merchantKey ?? null,
  },
});

/** The row shape `transactionApplier` (`diplomat/db/repos/transactions.ts`) writes — `modelToDb`'s
 *  flat props/refs merged onto the actual `transactions` table column names (drizzle's
 *  `fromAccountId`/`creditCardId`/`subcategoryId`, not the entity's own `refs.accountId`/`cardId`/
 *  `subCategoryId`), plus `version` (ADR-021). */
export type TransactionRowEntity = TransactionDbProps & {
  fromAccountId: string | null;
  toAccountId: string | null;
  creditCardId: string | null;
  billId: string | null;
  categoryId: string | null;
  subcategoryId: string | null;
  merchantKey: string | null;
  version: number;
};

/** entity→row for the versioned unit of work (ADR-021) — the only transaction write path that
 *  needs `version` on the wire-db row. Reuses `modelToDb` for the shared node properties/edge
 *  refs, then renames the refs onto their actual drizzle column names. */
export const entityToDb = (entity: TransactionEntity & { version: number }): TransactionRowEntity => {
  const { props, refs } = modelToDb(entity);
  return {
    ...props,
    fromAccountId: refs.accountId,
    toAccountId: refs.toAccountId,
    creditCardId: refs.cardId,
    billId: refs.billId,
    categoryId: refs.categoryId,
    subcategoryId: refs.subCategoryId,
    merchantKey: refs.merchantKey,
    version: entity.version,
  };
};

export const { persistableToDb, outcomeToDb } = persistence.entityDbAdapter(TRANSACTION_ENTITY_TAG, entityToDb);

// ─── wire/in→model ───────────────────────────────────────────────────────────

export const searchWireInToModel = (input: wireIn.SearchTransactionsInput): SearchTransactions => input;

export const confirmWireInToModel = (input: wireIn.ConfirmTransaction): ConfirmTransaction => input;

// ─── model→wire/out ──────────────────────────────────────────────────────────

// `classification` required (narrower than `UpsertTransactionResult`'s general optional field):
// this adapter is only ever reached from add_account_expense/add_account_income/add_card_purchase,
// never create_transfer (transfers are never classified — TransferResultOut has no such field).
export const createResultToWireOut = (result: ClassifiedUpsertResult): CreateTransactionOut =>
  CreateTransactionOut.parse(result);

const bulkItemToWireOut = (item: BulkItemResult<AppError>): BulkItemOut =>
  item.status === 'error'
    ? { status: 'error', description: item.description, error: formatAppError(item.error) }
    : item;

export const bulkResultToWireOut = (result: BulkResult<AppError>): BulkResultOut =>
  BulkResultOut.parse({ summary: result.summary, items: result.items.map(bulkItemToWireOut) });

export const deleteResultToWireOut = (result: DeleteTransactionResult): DeleteTransactionOut =>
  DeleteTransactionOut.parse(result);
