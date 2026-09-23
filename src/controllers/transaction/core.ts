// Transaction core (ADR-016): row integrity and category resolution shared by every aggregate.
// No bill/card knowledge — must never import logic/bill.js or touch deps.bills.
// Aggregates (credit-card, account) depend on this module; it never depends on them.

import { ok, okAsync, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  buildTransactionView,
  entityFromExisting,
  hasCategory,
  hasSubCategory,
  isCategoryKindAllowed,
  isTransfer,
  resolveEffectiveType,
} from '../../logic/transaction.js';
import {
  TRANSACTION_ENTITY_TAG,
  TransactionStatus,
  transactionErrors,
  type CategoryFields,
  type CategorySelection,
  type ConfirmTransaction,
  type MovementType,
  type TransactionEntity,
  type TransactionView,
  type UpdateTransaction,
} from '../../models/transaction.js';
import type { CurrencyCode } from '../../models/money.js';
import type { FlowOutcome, Persistable } from '../../effects/persistable.js';
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

/**
 * Flips a `pending` transaction to `effective`, optionally correcting `amount`/`date` in the same
 * call (Design 014 phase B) — a thin core flow rather than a delegation to `updateAccountTransaction`/
 * `updateCardTransaction`, whose guards this module can't reach. Immutability is enforced directly
 * via `isTransfer`: editing amount/date is rejected for a transfer/bill-payment, but a plain
 * status-only confirm of one is still fine. The future-date guard applies regardless of whether an
 * edit was supplied — `date` resolves to the (possibly already future-dated) existing date otherwise.
 */
export const confirmTransaction = (
  deps: Deps,
  input: ConfirmTransaction,
): ResultAsync<FlowOutcome<TransactionView>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));

    const locale = await deps.locale();

    if (existing.status === TransactionStatus.enum.effective) {
      return ok({ persist: [], response: addLocalizedLabels(existing, locale) });
    }

    const hasEdit = input.amount !== undefined || input.date !== undefined;
    yield* guard(!(hasEdit && isTransfer(existing)), transactionErrors.confirmEditNotAllowedForTransfer);

    const date = input.date ?? existing.date;
    yield* guard(date <= toIsoDate(deps.clock()), transactionErrors.cannotConfirmFutureDated(date));

    const entity: TransactionEntity = {
      ...entityFromExisting(existing),
      amount: input.amount ?? existing.amount,
      date,
      status: TransactionStatus.enum.effective,
    };

    const persist: Persistable[] = [
      persistence.update({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, version: existing.version } }),
    ];
    return ok({ persist, response: buildTransactionView(locale) });
  });

/** Generic patch input: the core's minimal `UpdateTransaction` (ADR-019) plus `account` — the one
 *  context field both aggregates' own FC/IS updates still resolve generically (the account
 *  aggregate's `UpdateAccountTransactionSchema` carries it; the credit-card aggregate's own schema
 *  carries it too, but only so `updateCardTransaction` can reject it with a dedicated error before
 *  ever calling `decideTransactionUpdate` — it always reaches this decision as `undefined` on that
 *  path). Declared locally rather than importing an aggregate's model type, so the core still names
 *  no sibling context's schema. */
type UpdateTransactionPatch = UpdateTransaction & { account?: string };

/** What every FC/IS update — the account aggregate's `updateAccountTransaction`
 *  (`controllers/account/transaction.ts`) and the credit-card aggregate's `updateCardTransaction`
 *  (`controllers/creditCard/transaction.ts`) — needs decided via injected reads, before either
 *  shapes its own write: the resolved new account (if any), the movement type a category-kind check
 *  should validate against, and the category/sub-category selection (if any field was provided).
 *  Extracted once here so both share the same reads/validation and never re-derive them
 *  differently. `account` is a minimal structural type (id + currency, the only fields either caller
 *  reads off it) rather than the full `Account` — this module must never import `models/account.ts`
 *  (dependency table). The real `Account` that `resolveAccountRef` (`controllers/resolve.ts`)
 *  resolves to structurally satisfies this narrower type, so neither side has to name the other's
 *  model. */
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
