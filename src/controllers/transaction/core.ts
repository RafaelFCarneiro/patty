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
  type UpdateTransactionPatch,
  type TransactionUpdateDecision,
} from '../../models/transaction.js';
import type { FlowOutcome, Persistable } from '@rfc0/effect-runner';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCategoryRef, resolveSubCategoryRef } from '../resolve.js';

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
