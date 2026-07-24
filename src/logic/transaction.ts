import { purry } from 'remeda';
import { IsoDate } from '../models/date.js';
import type { Locale } from '../models/locale.js';
import { CURSOR_VERSION, decodeCursor, encodeCursor, type CursorKey, type SortDirection } from '../models/page.js';
import type {
  CategoryFields,
  Classification,
  ClassifiedUpsertResult,
  ClassifyOutcome,
  DefaultedStatementLine,
  UpsertTransactionResult,
  SearchTransactions,
  StatementLine,
  TransactionEntity,
  TransactionError,
  TransactionView,
  UpdateTransaction,
} from '../models/transaction.js';
import type { RawTransactionView } from '../models/transaction.js';
import type { PersistOutcome } from '../models/persistable.js';
import { outcomeFor } from './persistence.js';
import {
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

/** Transfers and bill-payment transactions are exactly `type === 'transfer'` (ADR-002) — a
 *  core-visible fact needing no ownership resolution, unlike transfer *mutation policy*
 *  (`guardTransferMutability`), which stays in the account context (ADR-020). */
export const isTransfer = (t: Pick<TransactionView, 'type'>): boolean => t.type === TransactionType.enum.transfer;

/** The effective movement type after applying an update, or undefined for transfers. */
export const resolveEffectiveType = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransaction, 'type'>,
): 'income' | 'expense' | undefined => {
  const resolved = input.type ?? existing.type;
  return resolved !== TransactionType.enum.transfer ? resolved : undefined;
};

/** `RawTransactionView` → plain `TransactionEntity`, for a flow (`confirmTransaction`) that builds
 *  its `update` `Persistable` by overriding a few fields on top of the existing row. */
export const entityFromExisting = (existing: RawTransactionView): TransactionEntity => ({
  id: existing.id,
  description: existing.description,
  amount: existing.amount,
  type: existing.type,
  status: existing.status,
  date: existing.date,
  currency: existing.currency,
  source: existing.source,
  idempotencyKey: existing.idempotencyKey,
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

// ─── Bulk ─────────────────────────────────────────────────────────────────────

/** Stable idempotency key derived from statement line: re-importing is a no-op. */
export const deriveIdempotencyKey = (item: { date: string; description: string; amount: number }): string =>
  `${item.date}-${normalizeMerchant(item.description).replace(/\s+/g, '-') || 'tx'}-${item.amount.toFixed(2)}`;

// today is the caller's already-resolved toIsoDate(deps.clock()) — logic never reads the clock.
export const defaultStatementLines = <Line extends StatementLine>(
  today: string,
  lines: readonly Line[],
  rawInput: string | undefined,
): DefaultedStatementLine<Line>[] =>
  lines.map((line) => {
    const date = line.date ?? today;
    const idempotencyKey = line.idempotencyKey ?? deriveIdempotencyKey({ ...line, date });
    return { ...line, date, idempotencyKey, rawInput };
  });

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Items the agent should surface to the user for category confirmation. */
export const needsReview = (c: Classification): boolean =>
  c.method === 'none' || c.confidence < LOW_CONFIDENCE_THRESHOLD;

export type BulkItemResult<E = unknown> =
  | { status: 'created' | 'needs_review'; transaction: TransactionView; classification: ClassifyOutcome }
  | { status: 'duplicate'; transaction: TransactionView }
  | { status: 'error'; description: string; error: E };

export const toBulkItemResult = <E>(
  // Bulk import never represents a transfer (single-source: every line is a movement/card
  // purchase — ADR-017 step 2), so `classification` is always present here — narrower than the
  // general `UpsertTransactionResult` (`create_transfer` is the one flow that omits it).
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

// ─── Localized labels ───────────────────────────────────────────────────────

const _addLocalizedLabels = (tx: RawTransactionView, locale: Locale): TransactionView => {
  // version: internal concurrency token (ADR-021) — dropped here, never reaches wire/out.
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

// ─── ADR-021: building a TransactionView from the shell's apply outcome (rule 6) ────────────────

/** Resolves the entity's persisted, joined view from the shell's apply outcome and localizes it —
 *  the one place `PersistOutcome.read` gets cast back to `RawTransactionView` (trusting the entity
 *  contract) and turned into wire-ready shape. Pure model-building — no `created`/`classification`
 *  envelope here; that's each flow's own result shape to assemble, not this function's job. */
const _viewFromOutcome = (outcome: PersistOutcome, locale: Locale): TransactionView =>
  addLocalizedLabels(outcome.read as RawTransactionView, locale);

export function viewFromOutcome(outcome: PersistOutcome, locale: Locale): TransactionView;
export function viewFromOutcome(locale: Locale): (outcome: PersistOutcome) => TransactionView;
export function viewFromOutcome(...args: readonly unknown[]) {
  return purry(_viewFromOutcome, args);
}

/** `viewFromOutcome`, resolved against the transaction's own outcome by entity tag — a flow like
 *  `update_account_transaction`/`update_card_transaction` has no `created` flag to derive (an
 *  update either lands or the whole unit of work fails as a `conflict` before any outcome is ever
 *  reported — rule 4 — so there's no duplicate-replay case to distinguish the way there is for an
 *  insert). */
const _buildTransactionView = (outcomes: PersistOutcome[], locale: Locale): TransactionView =>
  viewFromOutcome(outcomeFor(TRANSACTION_ENTITY_TAG, outcomes), locale);

export function buildTransactionView(outcomes: PersistOutcome[], locale: Locale): TransactionView;
export function buildTransactionView(locale: Locale): (outcomes: PersistOutcome[]) => TransactionView;
export function buildTransactionView(...args: readonly unknown[]) {
  return purry(_buildTransactionView, args);
}

/**
 * Builds every insert-shaped flow's result (`UpsertTransactionResult` — `models/transaction.ts`):
 * the localized view, plus whether the shell's insert actually landed. `created` is never faked by
 * the domain — always read off the real apply outcome; on an idempotent duplicate replay,
 * `outcome.read` (and so `transaction`) is the EXISTING row, not this attempt's own values.
 * `classification` is the one field that genuinely varies per flow (present for a movement,
 * `undefined` for a transfer — transfers are never classified) — passed through as-is rather than
 * each flow assembling its own envelope around a shared `{ transaction, created }` core, since
 * `UpsertTransactionResult` is that one shape every insert-shaped flow already returns.
 */
const _buildUpsertResult = (
  outcomes: PersistOutcome[],
  classification: ClassifyOutcome | undefined,
  locale: Locale,
): UpsertTransactionResult => {
  const outcome = outcomeFor(TRANSACTION_ENTITY_TAG, outcomes);
  return { transaction: viewFromOutcome(outcome, locale), created: outcome.applied, classification };
};

// Two overload pairs (data-first / data-last), each split on whether `classification` is a real
// value or `undefined` — so a caller with a `ClassifyOutcome` in hand gets back
// `ClassifiedUpsertResult` (no re-narrowing needed), and `create_transfer`'s explicit `undefined`
// still gets the general `UpsertTransactionResult`.
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
