import {
  RawTransactionViewSchema,
  TRANSACTION_ENTITY_TAG,
  type RawTransactionView,
  type Transaction,
  type TransactionEntity,
  type ClassifiedUpsertResult,
  type ConfirmTransaction,
  type DeleteTransactionResult,
  type SearchTransactions,
  type BulkItemResult,
  type BulkResult,
} from '../models/transaction.js';
import { LocalizedNamesSchema, type LocalizedNames } from '../models/category.js';
import { type AppError, formatAppError } from '../common/errors.js';
import * as persistence from '../logic/persistence.js';
import { TransactionRowSchema, type TransactionDbProps, type TransactionDbRefs } from '../wire/db/transactions.js';
import type * as wireIn from '../wire/in/transactions.js';
import {
  type BulkItemOut,
  BulkResultOut,
  CreateTransactionOut,
  DeleteTransactionOut,
} from '../wire/out/transactions.js';

export const optional = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const parseTags = (json: string | null): string[] =>
  (json ? (JSON.parse(json) as unknown[]) : []).filter((tag): tag is string => typeof tag === 'string');

export const parseNames = (json: string | null): LocalizedNames =>
  json !== null ? LocalizedNamesSchema.parse(JSON.parse(json)) : null;

export const dbToModel = (record: Record<string, unknown>): RawTransactionView => {
  const row = TransactionRowSchema.parse(record);

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
    rawInput: optional(row.raw_input),
    note: optional(row.note),
    accountId: optional(row.from_account_id),
    accountName: optional(row.from_account_name),
    toAccountId: optional(row.to_account_id),
    toAccountName: optional(row.to_account_name),
    cardId: optional(row.credit_card_id),
    cardName: optional(row.credit_card_name),
    billId: optional(row.bill_id),
    categoryId: optional(row.category_id),
    categoryName: optional(row.category_name),
    categoryNames: parseNames(row.category_names),
    subCategoryId: optional(row.subcategory_id),
    subCategoryName: optional(row.subcategory_name),
    subCategoryNames: parseNames(row.subcategory_names),
    merchant: optional(row.merchant_key),
    tags: parseTags(row.tags),
    version: row.version,
  });
};

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
