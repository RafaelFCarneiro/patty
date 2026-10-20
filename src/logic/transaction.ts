import { createHash } from 'node:crypto';
import { purry } from 'remeda';
import { IsoDate } from '../models/date.js';
import type { Locale } from '../models/locale.js';
import { roundToDecimals } from './money.js';
import { CURSOR_VERSION, decodeCursor, encodeCursor, type CursorKey, type SortDirection } from '../models/page.js';
import type {
  CategoryFields,
  CategorySelection,
  Classification,
  ClassifiedUpsertResult,
  ClassifyOutcome,
  DefaultedStatementLine,
  IdempotencyIdentity,
  MerchantMatch,
  NewTransactionFacts,
  NewTransactionPlan,
  PatchFields,
  PatchOverrides,
  UpsertTransactionResult,
  SearchTransactions,
  StatementLine,
  TransactionEntity,
  TransactionError,
  TransactionView,
  UpdateTransaction,
} from '../models/transaction.js';
import type { RawTransactionView } from '../models/transaction.js';
import type { PersistOutcome } from '@rfc0/effect-runner';
import { outcomeFor } from './persistence.js';
import type { CurrencyCode } from '../models/money.js';
import {
  ClassificationMethod,
  transactionErrors,
  TRANSACTION_ENTITY_TAG,
  TransactionCursorSchema,
  TransactionSortField,
  TransactionStatus,
  TransactionType,
  type MovementType,
} from '../models/transaction.js';
import { CategoryKind } from '../models/category.js';
import { err, ok, type Result } from 'neverthrow';
import * as R from 'remeda';
import { localizeCategoryName } from './category.js';
import { pickClassification, userClassification } from './classify.js';
import { localizeTransactionStatus, localizeTransactionType } from './localize.js';
import { normalizeMerchant } from './merchant.js';

export const defaultStatusFor = (date: IsoDate, today: IsoDate): TransactionStatus =>
  date > today ? TransactionStatus.enum.pending : TransactionStatus.enum.effective;

export const hasCategory = (input: CategoryFields): input is CategoryFields & { category: string } =>
  R.isNonNullish(input.category);

export const hasSubCategory = (input: CategoryFields): input is CategoryFields & { subCategory: string } =>
  R.isNonNullish(input.subCategory);

export const assertExclusiveCategorySubCategory = (input: CategoryFields): boolean =>
  !(hasCategory(input) && hasSubCategory(input));

export const isCategoryKindAllowed = (txType: MovementType, categoryKind: CategoryKind): boolean =>
  categoryKind === CategoryKind.enum.both || categoryKind === txType;

const isValidCursorValue: Record<TransactionSortField, (value: string | number) => boolean> = {
  [TransactionSortField.enum.date]: (value) => typeof value === 'string' && IsoDate.safeParse(value).success,
  [TransactionSortField.enum.amount]: (value) => typeof value === 'number' && Number.isFinite(value),
};

export const resolveCursorKey = (
  input: Pick<SearchTransactions, 'cursor' | 'sort' | 'dir'>,
): Result<CursorKey | null, TransactionError> => {
  if (!input.cursor) return ok(null);
  const decoded = decodeCursor(TransactionCursorSchema, input.cursor);
  if (!decoded || decoded.sort !== input.sort || decoded.dir !== input.dir) {
    return err(transactionErrors.invalidCursor);
  }
  if (!isValidCursorValue[decoded.sort](decoded.key.value)) {
    return err(transactionErrors.invalidCursor);
  }
  return ok(decoded.key);
};

const CURSOR_VALUE_OF: Record<
  TransactionSortField,
  (row: Pick<TransactionView, 'date' | 'amount'>) => string | number
> = {
  [TransactionSortField.enum.date]: (row) => row.date,
  [TransactionSortField.enum.amount]: (row) => row.amount,
};

export const nextCursorAfter = (
  lastRow: Pick<TransactionView, 'date' | 'amount' | 'id'>,
  sort: TransactionSortField,
  dir: SortDirection,
): string =>
  encodeCursor({
    v: CURSOR_VERSION,
    sort,
    dir,
    key: { value: CURSOR_VALUE_OF[sort](lastRow), id: lastRow.id },
  });

export const isTransfer = (t: Pick<TransactionView, 'type'>): boolean => t.type === TransactionType.enum.transfer;

export const resolveEffectiveType = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransaction, 'type'>,
): 'income' | 'expense' | undefined => {
  const resolved = input.type ?? existing.type;
  return resolved !== TransactionType.enum.transfer ? resolved : undefined;
};

export const entityFromExisting = (existing: RawTransactionView): TransactionEntity => ({
  id: existing.id,
  description: existing.description,
  amount: existing.amount,
  type: existing.type,
  status: existing.status,
  date: existing.date,
  currency: existing.currency,
  source: existing.source,
  classification: existing.classification,
  rawInput: existing.rawInput,
  note: existing.note,
  refs: {
    accountId: existing.accountId,
    toAccountId: existing.toAccountId,
    cardId: existing.cardId,
    billId: existing.billId,
    categoryId: existing.categoryId,
    subCategoryId: existing.subCategoryId,
    merchantKey: existing.merchant,
  },
});

const patchedNote = (note: string | undefined, existing: string | undefined): string | undefined =>
  note === undefined ? existing : note || undefined;

const patchedClassification = (existing: RawTransactionView, selection: CategorySelection | null): Classification =>
  selection ? { method: ClassificationMethod.enum.user, confidence: 1 } : existing.classification;

const patchedCategoryRefs = (
  existing: RawTransactionView,
  selection: CategorySelection | null,
): Pick<TransactionEntity['refs'], 'categoryId' | 'subCategoryId'> =>
  selection
    ? { categoryId: selection.categoryId, subCategoryId: selection.subCategoryId }
    : { categoryId: existing.categoryId, subCategoryId: existing.subCategoryId };

const patchedFunding = (
  existing: RawTransactionView,
  overrides: PatchOverrides,
): Pick<TransactionEntity['refs'], 'accountId' | 'billId'> & { currency: CurrencyCode } => ({
  currency: overrides.account?.currency ?? existing.currency,
  accountId: overrides.account?.id ?? existing.accountId,
  billId: overrides.billId ?? existing.billId,
});

export const mergePatch = (
  existing: RawTransactionView,
  input: PatchFields,
  categorySelection: CategorySelection | null,
  overrides: PatchOverrides = {},
): TransactionEntity => {
  const base = entityFromExisting(existing);
  const { currency, ...fundingRefs } = patchedFunding(existing, overrides);
  return {
    ...base,
    description: input.description ?? existing.description,
    amount: input.amount ?? existing.amount,
    type: input.type ?? existing.type,
    date: input.date ?? existing.date,
    currency,
    classification: patchedClassification(existing, categorySelection),
    note: patchedNote(input.note, existing.note),
    refs: { ...base.refs, ...fundingRefs, ...patchedCategoryRefs(existing, categorySelection) },
  };
};

const classifyNew = (selection: CategorySelection | null, candidates: readonly MerchantMatch[]): ClassifyOutcome =>
  selection
    ? userClassification({ id: selection.categoryId, name: selection.categoryName })
    : pickClassification(candidates);

const merchantKeyFor = (classification: ClassifyOutcome, description: string, keepsUnmatched: boolean) =>
  classification.merchantKey ?? (keepsUnmatched ? normalizeMerchant(description) || undefined : undefined);

export const planNewTransaction = (facts: NewTransactionFacts): NewTransactionPlan => {
  const { input, type, currency, funding } = facts;
  const date = input.date ?? facts.today;
  const classification = classifyNew(facts.categorySelection, facts.candidates);
  const entity: TransactionEntity = {
    id: facts.id,
    description: input.description,
    amount: input.amount,
    type,
    status: input.status ?? defaultStatusFor(date, facts.today),
    date,
    currency,
    source: facts.source,
    classification,
    rawInput: input.rawInput,
    note: input.note,
    refs: {
      ...funding.refs,
      categoryId: classification.categoryId,
      subCategoryId: facts.categorySelection?.subCategoryId,
      merchantKey: merchantKeyFor(classification, input.description, facts.keepsUnmatchedMerchant),
    },
  };
  const idempotencyKey = deriveIdempotencyKey(
    {
      fundingSourceId: funding.sourceId,
      billPeriodKey: funding.billPeriodKey,
      type,
      currency,
      date,
      description: input.description,
      amount: input.amount,
    },
    facts.decimals,
    input.discriminator,
  );
  return { entity, classification, idempotencyKey };
};

export const deriveIdempotencyKey = (
  identity: IdempotencyIdentity,
  decimals: number,
  discriminator?: string,
): string => {
  // JSON.stringify, not a joined string: the discriminator is free text and could forge a field boundary.
  const canonical = JSON.stringify([
    identity.fundingSourceId ?? null,
    identity.counterpartyId ?? null,
    identity.billPeriodKey ?? null,
    identity.type,
    identity.currency,
    identity.date,
    normalizeMerchant(identity.description),
    // Rounded first: toFixed alone truncates at a float boundary such as 1.005.
    roundToDecimals(identity.amount, decimals).toFixed(decimals),
    discriminator ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
};

export const defaultStatementLines = <Line extends StatementLine>(
  today: string,
  lines: readonly Line[],
  rawInput: string | undefined,
): DefaultedStatementLine<Line>[] => lines.map((line) => ({ ...line, date: line.date ?? today, rawInput }));

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export const needsReview = (c: Classification): boolean =>
  c.method === 'none' || c.confidence < LOW_CONFIDENCE_THRESHOLD;

export type BulkItemResult<E = unknown> =
  | { status: 'created' | 'needs_review'; transaction: TransactionView; classification: ClassifyOutcome }
  | { status: 'duplicate'; transaction: TransactionView }
  | { status: 'error'; description: string; error: E };

export const toBulkItemResult = <E>(
  result: Result<ClassifiedUpsertResult, E>,
  description: string,
): BulkItemResult<E> =>
  result.match(
    (r) =>
      !r.created
        ? { status: 'duplicate', transaction: r.transaction }
        : {
            status: needsReview(r.classification) ? 'needs_review' : 'created',
            transaction: r.transaction,
            classification: r.classification,
          },
    (error) => ({ status: 'error', description, error }),
  );

export type BulkResult<E = unknown> = {
  summary: { created: number; needsReview: number; duplicates: number; errors: number };
  items: BulkItemResult<E>[];
};

export const summarizeBulkItems = (
  items: BulkItemResult<unknown>[],
): { created: number; needsReview: number; duplicates: number; errors: number } => {
  const counts = R.countBy(items, (i) => i.status);
  return {
    created: counts['created'] ?? 0,
    needsReview: counts['needs_review'] ?? 0,
    duplicates: counts['duplicate'] ?? 0,
    errors: counts['error'] ?? 0,
  };
};

const _addLocalizedLabels = (tx: RawTransactionView, locale: Locale): TransactionView => {
  const { categoryNames, subCategoryNames, version, ...base } = tx;
  return {
    ...base,
    typeLabel: localizeTransactionType(tx.type, locale),
    statusLabel: localizeTransactionStatus(tx.status, locale),
    categoryName: localizeCategoryName(tx.categoryName, categoryNames, locale),
    subCategoryName: localizeCategoryName(tx.subCategoryName, subCategoryNames, locale),
  };
};

export function addLocalizedLabels(tx: RawTransactionView, locale: Locale): TransactionView;
export function addLocalizedLabels(locale: Locale): (tx: RawTransactionView) => TransactionView;
export function addLocalizedLabels(...args: readonly unknown[]) {
  return purry(_addLocalizedLabels, args);
}

const _viewFromOutcome = (outcome: PersistOutcome, locale: Locale): TransactionView =>
  addLocalizedLabels(outcome.read as RawTransactionView, locale);

export function viewFromOutcome(outcome: PersistOutcome, locale: Locale): TransactionView;
export function viewFromOutcome(locale: Locale): (outcome: PersistOutcome) => TransactionView;
export function viewFromOutcome(...args: readonly unknown[]) {
  return purry(_viewFromOutcome, args);
}

const _buildTransactionView = (outcomes: PersistOutcome[], locale: Locale): TransactionView =>
  viewFromOutcome(outcomeFor(TRANSACTION_ENTITY_TAG, outcomes), locale);

export function buildTransactionView(outcomes: PersistOutcome[], locale: Locale): TransactionView;
export function buildTransactionView(locale: Locale): (outcomes: PersistOutcome[]) => TransactionView;
export function buildTransactionView(...args: readonly unknown[]) {
  return purry(_buildTransactionView, args);
}

const _buildUpsertResult = (
  outcomes: PersistOutcome[],
  classification: ClassifyOutcome | undefined,
  locale: Locale,
): UpsertTransactionResult => {
  const outcome = outcomeFor(TRANSACTION_ENTITY_TAG, outcomes);
  return { transaction: viewFromOutcome(outcome, locale), created: outcome.applied, classification };
};

export function buildUpsertResult(
  outcomes: PersistOutcome[],
  classification: ClassifyOutcome,
  locale: Locale,
): ClassifiedUpsertResult;
export function buildUpsertResult(
  outcomes: PersistOutcome[],
  classification: undefined,
  locale: Locale,
): UpsertTransactionResult;
export function buildUpsertResult(
  classification: ClassifyOutcome,
  locale: Locale,
): (outcomes: PersistOutcome[]) => ClassifiedUpsertResult;
export function buildUpsertResult(
  classification: undefined,
  locale: Locale,
): (outcomes: PersistOutcome[]) => UpsertTransactionResult;
export function buildUpsertResult(...args: readonly unknown[]) {
  return purry(_buildUpsertResult, args);
}
