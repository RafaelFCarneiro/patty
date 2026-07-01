import { purry } from 'remeda';
import type { ValidationError } from '../models/error.js';
import type { Account } from '../models/account.js';
import type { CreditCard } from '../models/creditCard.js';
import { CurrencyCode } from '../models/money.js';
import type { IsoDate } from '../models/date.js';
import type { Locale } from '../models/locale.js';
import type {
  Classification,
  ClassifyOutcome,
  CreateTransaction,
  CreateTransactionResult,
  TransactionView,
  UpdateTransaction,
} from '../models/transaction.js';
import type { RawTransactionView } from '../models/transaction.js';
import { transactionErrors, TransactionStatus, TransactionType, type MovementType } from '../models/transaction.js';
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

// ─── Currency ────────────────────────────────────────────────────────────────

/** Resolve transaction currency: account > card > explicit > USD default. */
export const resolveCurrency = (
  account: Pick<Account, 'currency'> | null,
  card: Pick<CreditCard, 'currency'> | null,
  input: Pick<CreateTransaction, 'currency'>,
): CurrencyCode => account?.currency ?? card?.currency ?? input.currency ?? CurrencyCode.enum.USD;

export const assertExclusiveAccountCard = (input: { account?: string; card?: string }): boolean =>
  !(input.account && input.card);

export const assertExclusiveCategorySubCategory = (input: { category?: string; subCategory?: string }): boolean =>
  !(input.category && input.subCategory);

export const isCategoryKindAllowed = (txType: MovementType, categoryKind: CategoryKind): boolean =>
  categoryKind === CategoryKind.enum.both || categoryKind === txType;

// ─── Transfer mutability guards ───────────────────────────────────────────────

const isTransfer = (t: Pick<TransactionView, 'type'>) => t.type === TransactionType.enum.transfer;
const wouldBeTransfer = (existing: Pick<TransactionView, 'type'>, input: Pick<UpdateTransaction, 'type'>) =>
  (input.type ?? existing.type) === TransactionType.enum.transfer;
const hasCategoryInput = (input: Pick<UpdateTransaction, 'category' | 'subCategory'>) =>
  !!(input.category || input.subCategory);

/**
 * Enforce transfer invariants on update:
 * - A transfer's type cannot be changed.
 * - A transfer cannot receive a category or sub-category.
 */
export const guardTransferMutability = (
  existing: Pick<TransactionView, 'type'>,
  input: Pick<UpdateTransaction, 'type' | 'category' | 'subCategory'>,
): Result<void, ValidationError> => {
  if (isTransfer(existing) && input.type) return err(transactionErrors.transferTypeImmutable);
  if (wouldBeTransfer(existing, input) && hasCategoryInput(input))
    return err(transactionErrors.transferCategoryRejected);
  return ok(undefined);
};

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
