// Transaction core (ADR-016): row integrity, category resolution, and generic patch/delete
// primitives. No bill/card knowledge — must never import logic/bill.js or touch deps.bills.
// Aggregates (credit-card, account) depend on this module; it never depends on them.

import { ok, okAsync, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { resolveMerchantCorrection } from '../../logic/merchant.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  hasCategory,
  hasSubCategory,
  isCategoryKindAllowed,
  resolveEffectiveType,
} from '../../logic/transaction.js';
import {
  ClassificationMethod,
  DELETE_TRANSACTION_CONFIRM_HINT,
  TransactionStatus,
  transactionErrors,
  type CategoryFields,
  type CategorySelection,
  type DeleteTransactionResult,
  type MovementType,
  type RawTransactionView,
  type TransactionView,
  type UpdateTransaction,
} from '../../models/transaction.js';
import type { CurrencyCode } from '../../models/money.js';
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

/** Generic patch input: the core's minimal `UpdateTransaction` (ADR-019) plus `account` — the one
 *  context field the shared persistence side still resolves/patches generically (the account
 *  aggregate's `UpdateAccountTransactionSchema` carries it; the credit-card aggregate's own schema
 *  carries it too, but only so `updateCardTransaction` can reject it with a dedicated error before
 *  ever delegating here — it always reaches this patch as `undefined` on that path). Declared
 *  locally rather than importing an aggregate's model type, so the core still names no sibling
 *  context's schema. */
type UpdateTransactionPatch = UpdateTransaction & { account?: string };

/** What every update — the credit-card aggregate's own (still repo-driven, below) and the account
 *  aggregate's FC/IS one (`controllers/account/transaction.ts`'s `updateAccountTransaction`) —
 *  needs decided via injected reads, before either shapes its own write: the resolved new account
 *  (if any), the movement type a category-kind check should validate against, and the category/
 *  sub-category selection (if any field was provided). Extracted once here so the two callers
 *  share the same reads/validation and never re-derive them differently. `account` is a minimal
 *  structural type (id + currency, the only fields either caller reads off it) rather than the
 *  full `Account` — this module must never import `models/account.ts` (dependency table). The
 *  real `Account` that `resolveAccountRef` (`controllers/resolve.ts`) resolves to structurally
 *  satisfies this narrower type, so neither side has to name the other's model. */
type TransactionUpdateDecision = {
  account: { id: string; currency: CurrencyCode } | null;
  effectiveType: MovementType | undefined;
  categorySelection: CategorySelection | null;
};

export const decideTransactionUpdate = (
  deps: Deps,
  input: UpdateTransactionPatch,
  existing: Pick<TransactionView, 'type'>,
): ResultAsync<TransactionUpdateDecision, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    const account = R.isNonNullish(input.account) ? yield* resolveAccountRef(deps, input.account) : null;
    const effectiveType = resolveEffectiveType(existing, input);
    const categorySelection = yield* resolveCategorySelection(deps, input, effectiveType);
    return ok({ account, effectiveType, categorySelection });
  });

/**
 * Generic patch: category/currency/description/amount resolution, persistence, and merchant
 * learning. No bill/card concern — callers that own a bill relationship (the credit-card
 * aggregate) validate and settle it themselves before/after calling this. Still repo-driven
 * (`deps.transactions.update`) — used only by the credit-card aggregate
 * (`controllers/creditCard/transaction.ts`'s `updateCardTransaction`), not yet converted to FC/IS
 * (ADR-021 phase 2b). The account aggregate has its own converted `updateAccountTransaction`
 * (`controllers/account/transaction.ts`), sharing `decideTransactionUpdate` above rather than this
 * function, since its write shape (a `Persistable`) differs from this one's direct repo call.
 */
export const updateTransaction = (
  deps: Deps,
  input: UpdateTransactionPatch,
  existing: RawTransactionView,
): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const { account, categorySelection } = yield* decideTransactionUpdate(deps, input, existing);
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
    const merchantCorrection = resolveMerchantCorrection(existing, categoryId);
    if (merchantCorrection) {
      await deps.merchants.incrementCategoryWeight(merchantCorrection.merchantKey, merchantCorrection.categoryId);
    }

    const locale = await deps.locale();
    return ok(addLocalizedLabels(updated, locale));
  });

/** Generic delete: dry-run preview or physical row delete. No bill concern. Still repo-driven
 *  (`deps.transactions.delete`) — used only by the credit-card aggregate's
 *  `deleteCardTransaction`, not yet converted to FC/IS (ADR-021 phase 2b). */
export const deleteTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
  existing: RawTransactionView,
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();
    const labeled = addLocalizedLabels(existing, locale);

    if (!input.confirm)
      return ok({
        deleted: false as const,
        dryRun: true as const,
        wouldDelete: labeled,
        hint: DELETE_TRANSACTION_CONFIRM_HINT,
      });

    await deps.transactions.delete(input.id);
    return ok({ deleted: true as const, transaction: labeled });
  });
