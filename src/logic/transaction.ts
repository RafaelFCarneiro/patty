import { purry } from 'remeda';
import { IsoDate } from '../models/date.js';
import type { Locale } from '../models/locale.js';
import { CURSOR_VERSION, decodeCursor, encodeCursor, type CursorKey, type SortDirection } from '../models/page.js';
import type {
  CategoryFields,
  Classification,
  ClassifyOutcome,
  CreateTransactionResult,
  SearchTransactions,
  TransactionError,
  TransactionView,
  UpdateTransaction,
} from '../models/transaction.js';
import type { RawTransactionView } from '../models/transaction.js';
import {
  transactionErrors,
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
import { localizeTransactionStatus, localizeTransactionType } from './localize.js';
import { normalizeMerchant } from './merchant.js';

// ─── Status default ──────────────────────────────────────────────────────────

/**
 * Single source of the date-aware default rule.
 * Future-dated → pending (not yet happened); today/past → effective (already happened).
 * An explicit caller-supplied status always wins — this is only the fallback.
 */
export const defaultStatusFor = (date: IsoDate, today: IsoDate): TransactionStatus =>
  date > today ? TransactionStatus.enum.pending : TransactionStatus.enum.effective;

/**
 * True when a category name was provided — a type guard, narrowing `category` to `string`. The
 * schema rejects empty strings (`.min(1)`), so this only needs to rule out null/undefined; using
 * isNonNullish (rather than `!== undefined`) means a `null` would also correctly count as absent.
 */
export const hasCategory = (input: CategoryFields): input is CategoryFields & { category: string } =>
  R.isNonNullish(input.category);

/** True when a subCategory name was provided — same reasoning as hasCategory. */
export const hasSubCategory = (input: CategoryFields): input is CategoryFields & { subCategory: string } =>
  R.isNonNullish(input.subCategory);

// Value-based (via hasCategory/hasSubCategory), not truthiness — so e.g. a caller-constructed
// { category: undefined, subCategory: 'S' } is judged consistently with resolveCategorySelection.
export const assertExclusiveCategorySubCategory = (input: CategoryFields): boolean =>
  !(hasCategory(input) && hasSubCategory(input));

export const isCategoryKindAllowed = (txType: MovementType, categoryKind: CategoryKind): boolean =>
  categoryKind === CategoryKind.enum.both || categoryKind === txType;

// ─── Pagination (ADR-014) ──────────────────────────────────────────────────────

/** Validates `key.value` is actually well-formed for its own sort field — not just the right JS
 *  type. A tampered/stale cursor can carry a syntactically-typed but semantically bogus value
 *  (`{ sort: 'date', key: { value: 'not-a-date' } }`, or `{ sort: 'amount', key: { value: 1e309 } }`
 *  → `Infinity`, still `typeof 'number'`); either would otherwise reach the keyset predicate and
 *  silently mispage instead of being rejected as the malformed cursor it is. */
const isValidCursorValue: Record<TransactionSortField, (value: string | number) => boolean> = {
  [TransactionSortField.enum.date]: (value) => typeof value === 'string' && IsoDate.safeParse(value).success,
  [TransactionSortField.enum.amount]: (value) => typeof value === 'number' && Number.isFinite(value),
};

/** Decodes + validates an opaque search cursor against the request's own sort/dir — a cursor
 *  only makes sense for the ordering that produced it. No cursor supplied → first page (null key). */
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

/** ADR-014 whitelist: the only column each sort field may resolve to when deriving a cursor's
 *  keyset value from a result row — kept as an exhaustive map, mirroring diplomat/db's ORDER BY map. */
const CURSOR_VALUE_OF: Record<
  TransactionSortField,
  (row: Pick<TransactionView, 'date' | 'amount'>) => string | number
> = {
  [TransactionSortField.enum.date]: (row) => row.date,
  [TransactionSortField.enum.amount]: (row) => row.amount,
};

/** Builds the opaque cursor pointing to the page after `lastRow`, under the given sort/dir. */
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

// ─── Transfer row kind (ADR-019/ADR-020: policy lives in the account context; the row kind stays core) ───

/** The effective movement type after applying an update, or undefined for transfers. */
export const resolveEffectiveType = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransaction, 'type'>,
): 'income' | 'expense' | undefined => {
  const resolved = input.type ?? existing.type;
  return resolved !== TransactionType.enum.transfer ? resolved : undefined;
};

// ─── Bulk ─────────────────────────────────────────────────────────────────────

/** Stable idempotency key derived from statement line: re-importing is a no-op. */
export const deriveIdempotencyKey = (item: { date: string; description: string; amount: number }): string =>
  `${item.date}-${normalizeMerchant(item.description).replace(/\s+/g, '-') || 'tx'}-${item.amount.toFixed(2)}`;

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Items the agent should surface to the user for category confirmation. */
export const needsReview = (c: Classification): boolean =>
  c.method === 'none' || c.confidence < LOW_CONFIDENCE_THRESHOLD;

export type BulkItemResult<E = unknown> =
  | { status: 'created' | 'needs_review'; transaction: TransactionView; classification: ClassifyOutcome }
  | { status: 'duplicate'; transaction: TransactionView }
  | { status: 'error'; description: string; error: E };

export const toBulkItemResult = <E>(
  result: Result<CreateTransactionResult, E>,
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

// ─── Localized labels ───────────────────────────────────────────────────────

const _addLocalizedLabels = (tx: RawTransactionView, locale: Locale): TransactionView => {
  const { categoryNames, subCategoryNames, ...base } = tx;
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
