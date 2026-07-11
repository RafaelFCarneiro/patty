// Account aggregate (ADR-016 step 3): owns the account-movement entry points. Validates
// (category/sub-category exclusivity, non-credit account), then delegates row persistence to the
// transaction core — the core never depends on this module (the reverse is fine and expected).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertNonCreditType } from '../../logic/account.js';
import { pickClassification, userClassification } from '../../logic/classify.js';
import { normalizeMerchant } from '../../logic/merchant.js';
import { toIsoDate } from '../../logic/period.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  defaultStatusFor,
  resolveCurrency,
} from '../../logic/transaction.js';
import {
  accountErrors,
  type AddAccountMovement,
  type ImportAccountStatement,
  type UpdateAccountTransaction,
} from '../../models/account.js';
import {
  transactionErrors,
  MovementType,
  TransactionTool,
  type ClassifyOutcome,
  type CreateTransactionResult,
  type DeleteTransactionResult,
  type TransactionSource,
  type TransactionView,
} from '../../models/transaction.js';
import type { BulkResult } from '../../logic/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef } from '../resolve.js';
import { runStatementImport } from '../transaction/bulk.js';
import {
  assertOwnership,
  deleteTransaction as coreDeleteTransaction,
  resolveCategorySelection,
  updateTransaction as coreUpdateTransaction,
} from '../transaction/core.js';

/** Shared by addAccountExpense/addAccountIncome — everything but the fixed movement type. */
const addAccountMovement = (
  deps: Deps,
  input: AddAccountMovement,
  type: MovementType,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategory);

    const account = R.isNonNullish(input.account) ? yield* resolveAccountRef(deps, input.account) : null;
    if (account) {
      yield* guard(assertNonCreditType(account.type), accountErrors.creditPostRejected);
    }

    const today = toIsoDate(deps.clock());
    const date = input.date ?? today;
    const status = input.status ?? defaultStatusFor(date, today);

    const categorySelection = yield* resolveCategorySelection(deps, input, type);
    const classification: ClassifyOutcome = categorySelection
      ? userClassification({ id: categorySelection.categoryId, name: categorySelection.categoryName })
      : pickClassification(await deps.merchants.matchCandidates(normalizeMerchant(input.description)));
    const subCategoryId = categorySelection?.subCategoryId;

    const { transaction, created } = await deps.transactions.create(
      {
        id: deps.newId(),
        description: input.description,
        amount: input.amount,
        type,
        status,
        date,
        currency: resolveCurrency(account, null, input),
        source,
        idempotencyKey: input.idempotencyKey,
        classification,
        rawInput: input.rawInput,
        note: input.note,
        refs: {
          accountId: account?.id,
          categoryId: classification.categoryId,
          subCategoryId,
          merchantKey: classification.merchantKey,
        },
      },
      input.tags ?? [],
    );

    const locale = await deps.locale();
    return ok({ transaction: addLocalizedLabels(transaction, locale), created, classification });
  });

export const addAccountExpense = (
  deps: Deps,
  input: AddAccountMovement,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> => addAccountMovement(deps, input, MovementType.enum.expense, source);

export const addAccountIncome = (
  deps: Deps,
  input: AddAccountMovement,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> => addAccountMovement(deps, input, MovementType.enum.income, source);

/**
 * Import an account statement (ADR-017 step 2): single-source — every item belongs to the ONE
 * account named in `input.account` (or unattached if omitted), so there is no per-line account to
 * resolve or route. Each line's own `type` picks `addAccountExpense` or `addAccountIncome` (the
 * movement kind is still a per-line discriminator here, unlike the single-movement tools, since a
 * statement mixes expenses and income); both are bound to the fixed account and delegate the
 * generic import plumbing (defaulting, dedup, needs-review flagging) to `runStatementImport`.
 */
export const importAccountStatement = (
  deps: Deps,
  input: ImportAccountStatement,
  source: TransactionSource,
): ResultAsync<BulkResult<AppError>, AppError> =>
  runStatementImport(deps, input.items, input.rawInput, source, (d, line, src) => {
    const movement = R.omit(line, ['type']);
    return line.type === MovementType.enum.expense
      ? addAccountExpense(d, { ...movement, account: input.account }, src)
      : addAccountIncome(d, { ...movement, account: input.account }, src);
  });

/**
 * Update an account transaction (ADR-017): asserts the target is account-owned (neither `cardId`
 * nor `billId`) — a card-owned id is rejected with a redirect to `update_card_transaction` — then
 * delegates the generic patch to the transaction core.
 */
export const updateAccountTransaction = (
  deps: Deps,
  input: UpdateAccountTransaction,
): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    yield* assertOwnership(existing, false, TransactionTool.updateCardTransaction);
    return ok(yield* coreUpdateTransaction(deps, input, existing));
  });

/**
 * Delete an account transaction (ADR-017): same ownership guard as updateAccountTransaction, then
 * the core's generic dry-run/delete.
 */
export const deleteAccountTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    yield* assertOwnership(existing, false, TransactionTool.deleteCardTransaction);
    return ok(yield* coreDeleteTransaction(deps, input, existing));
  });
