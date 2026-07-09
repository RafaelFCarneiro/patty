// Transaction core (ADR-016): row integrity, category resolution, and generic patch/delete
// primitives. No bill/card knowledge — must never import logic/bill.js or touch deps.bills.
// Aggregates (credit-card, account) depend on this module; it never depends on them.

import { ok, okAsync, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  assertBillPeriodPaired,
  guardTransferMutability,
  hasCategory,
  hasSubCategory,
  isCategoryKindAllowed,
  resolveEffectiveType,
} from '../../logic/transaction.js';
import {
  ClassificationMethod,
  TransactionStatus,
  transactionErrors,
  type CategoryFields,
  type CategorySelection,
  type DeleteTransactionResult,
  type MovementType,
  type TransactionView,
  type UpdateTransaction,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCategoryRef, resolveSubCategoryRef } from '../resolve.js';

/** Resolves a category by name, guarding kind-compatibility when the movement type is known. */
const resolveCategory = (
  deps: Deps,
  category: string,
  movementType: MovementType | undefined,
): ResultAsync<CategorySelection, AppError> =>
  safeTry(async function* () {
    const cat = yield* resolveCategoryRef(deps, category);
    if (movementType)
      yield* guard(
        isCategoryKindAllowed(movementType, cat.kind),
        transactionErrors.categoryKindMismatch(movementType, cat.name, cat.kind),
      );
    return ok({ categoryId: cat.id, categoryName: cat.name });
  });

/** Resolves a sub-category by name, guarding kind-compatibility when the movement type is known. */
const resolveSubCategory = (
  deps: Deps,
  subCategory: string,
  movementType: MovementType | undefined,
): ResultAsync<CategorySelection, AppError> =>
  safeTry(async function* () {
    const subCat = yield* resolveSubCategoryRef(deps, subCategory);
    if (movementType)
      yield* guard(
        isCategoryKindAllowed(movementType, subCat.kind),
        transactionErrors.categoryKindMismatch(movementType, subCat.name, subCat.kind),
      );
    return ok({ categoryId: subCat.parentId, categoryName: subCat.parentName, subCategoryId: subCat.id });
  });

/**
 * Dispatches to subCategory (preferred) or category resolution by whichever the caller provided.
 * Returns null when neither was given — callers decide what "unset" means for them (auto-classify
 * on create, leave the existing category untouched on update).
 */
export const resolveCategorySelection = (
  deps: Deps,
  input: CategoryFields,
  movementType: MovementType | undefined,
): ResultAsync<CategorySelection | null, AppError> =>
  R.conditional(
    input,
    [hasSubCategory, (i) => resolveSubCategory(deps, i.subCategory, movementType)],
    [hasCategory, (i) => resolveCategory(deps, i.category, movementType)],
    () => okAsync(null),
  );

/** Flip a pending transaction to effective. No-op (returns existing) if already effective. */
export const confirmTransaction = (deps: Deps, input: { id: string }): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));

    const locale = await deps.locale();

    if (existing.status === TransactionStatus.enum.effective) return ok(addLocalizedLabels(existing, locale));

    const confirmed = yield* okOr(await deps.transactions.confirm(input.id), transactionErrors.notFound(input.id));
    return ok(addLocalizedLabels(confirmed, locale));
  });

/**
 * Generic patch: category/currency/description/amount resolution, persistence, and merchant
 * learning. No bill/card concern — callers that own a bill relationship (the credit-card
 * aggregate) validate and settle it themselves before/after calling this.
 */
export const updateTransaction = (
  deps: Deps,
  input: UpdateTransaction,
  existing: TransactionView,
): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);
    yield* guardTransferMutability(existing, input);
    // Reached only for a transaction the router judged card-less (no `existing.cardId`) — any
    // billMonth/billYear reassignment request against one is invalid, card or not.
    yield* guard(input.billMonth === undefined, transactionErrors.billAssignmentRequiresCard);

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const effectiveType = resolveEffectiveType(existing, input);

    const categorySelection = yield* resolveCategorySelection(deps, input, effectiveType);
    const categoryId = categorySelection?.categoryId ?? null;
    // undefined = leave the sub-category untouched (nothing given); null = explicitly clear it
    // (a plain category was given, with no sub-category); defined = set to the resolved sub-category.
    const subCategoryId = categorySelection ? (categorySelection.subCategoryId ?? null) : undefined;
    const isUserCorrection = !!categorySelection;

    const updated = yield* okOr(
      await deps.transactions.update(
        input.id,
        {
          description: input.description,
          amount: input.amount,
          type: input.type,
          date: input.date,
          currency: account?.currency,
          classification: isUserCorrection ? { method: ClassificationMethod.enum.user, confidence: 1 } : undefined,
          note: input.note,
        },
        { accountId: account?.id ?? null, categoryId, subCategoryId, tagNames: input.tags ?? null },
      ),
      transactionErrors.notFound(input.id),
    );

    // Learning loop: correcting the category strengthens the merchant→category association
    if (categoryId && categoryId !== existing.categoryId)
      await deps.merchants.strengthenFromTransaction(input.id, categoryId);

    const locale = await deps.locale();
    return ok(addLocalizedLabels(updated, locale));
  });

/** Generic delete: dry-run preview or physical row delete. No bill concern. */
export const deleteTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
  existing: TransactionView,
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();
    const labeled = addLocalizedLabels(existing, locale);

    if (!input.confirm)
      return ok({
        deleted: false as const,
        dryRun: true as const,
        wouldDelete: labeled,
        hint: 'Destructive action: show the transaction to the user and call again with confirm: true.',
      });

    await deps.transactions.delete(input.id);
    return ok({ deleted: true as const, transaction: labeled });
  });
