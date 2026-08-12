// Account aggregate: owns the account-movement entry points. Validates (category/sub-category
// exclusivity, non-credit account), then hands the write off as a `Persistable` — the core never
// depends on this module (the reverse is fine and expected).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertNonCreditType, guardTransferMutability, isAccountOwnedType } from '../../logic/account.js';
import { pickClassification, userClassification } from '../../logic/classify.js';
import { decimalsLookup, resolveCurrency } from '../../logic/money.js';
import {
  normalizeMerchant,
  resolveMerchantCorrection,
  withMerchant,
  withMerchantLearning,
} from '../../logic/merchant.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { overlayResolvedTags } from '../../logic/tag.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  buildTransactionView,
  buildUpsertResult,
  defaultStatementLines,
  defaultStatusFor,
} from '../../logic/transaction.js';
import {
  accountErrors,
  type AddAccountMovement,
  type ImportAccountStatement,
  type ImportAccountStatementItem,
  type UpdateAccountTransaction,
} from '../../models/account.js';
import { CurrencyCode } from '../../models/money.js';
import { type FlowOutcome, type Persistable, type PersistOutcome } from '../../models/persistable.js';
import {
  ClassificationMethod,
  DELETE_TRANSACTION_CONFIRM_HINT,
  TRANSACTION_ENTITY_TAG,
  transactionErrors,
  MovementType,
  TransactionTool,
  type ClassifiedUpsertResult,
  type ClassifyOutcome,
  type DeleteTransactionResult,
  type TransactionEntity,
  type TransactionSource,
  type TransactionView,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveLegAccounts, resolveTagLinks } from '../resolve.js';
import type { StatementImportPlan } from '../transaction/bulk.js';
import { decideTransactionUpdate, resolveCategorySelection } from '../transaction/core.js';

/**
 * Repo-touching precondition: true when every leg the transaction has resolves to one of *this*
 * aggregate's own account types — a positive scope test (`isAccountOwnedType`), not the negation
 * of the credit-card aggregate's test. The account domain doesn't ask "does the credit-card
 * aggregate own this instead"; it asks "is every leg mine", vacuously true for an unattached movement.
 */
const assertAccountOwnedLegs = (
  deps: Deps,
  tx: Pick<TransactionView, 'accountId' | 'toAccountId'>,
): ResultAsync<boolean, AppError> =>
  resolveLegAccounts(deps, tx).map((legs) => legs.every((account) => isAccountOwnedType(account.type)));

type MovementPlan = { entity: TransactionEntity; classification: ClassifyOutcome };

const planAccountMovement = (
  deps: Deps,
  input: AddAccountMovement,
  type: MovementType,
  source: TransactionSource,
): ResultAsync<MovementPlan, AppError> =>
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
    const normalizedMerchant = normalizeMerchant(input.description);
    const classification: ClassifyOutcome = categorySelection
      ? userClassification({ id: categorySelection.categoryId, name: categorySelection.categoryName })
      : pickClassification(await deps.merchants.matchCandidates(normalizedMerchant));
    const subCategoryId = categorySelection?.subCategoryId;
    // A match reuses the (possibly partial) key merchant_category already learned under — reusing
    // it keeps future corrections reinforcing that same generalized key. Unmatched still needs a
    // key stored on the row, or a later correction has nothing to attach to (it can only ever
    // strengthen a merchant this transaction is already linked to) — falls back to the full
    // normalized description, empty-string guarded since that can't back a merchants FK row.
    const merchantKey = classification.merchantKey ?? (normalizedMerchant || undefined);

    const entity: TransactionEntity = {
      id: deps.newId(),
      description: input.description,
      amount: input.amount,
      type,
      status,
      date,
      currency: resolveCurrency(account, input),
      source,
      idempotencyKey: input.idempotencyKey,
      classification,
      rawInput: input.rawInput,
      note: input.note,
      refs: {
        accountId: account?.id,
        categoryId: classification.categoryId,
        subCategoryId,
        merchantKey,
      },
    };

    return ok({ entity, classification });
  });

/** Shared by addAccountExpense/addAccountIncome — everything but the fixed movement type. Returns
 *  the write as data: the shell applies the insert and reports back whether it actually landed
 *  (vs. an idempotent duplicate replay), which is what `created` reflects here — never faked by
 *  the domain. */
const addAccountMovement = (
  deps: Deps,
  input: AddAccountMovement,
  type: MovementType,
  source: TransactionSource,
): ResultAsync<FlowOutcome<ClassifiedUpsertResult>, AppError> =>
  safeTry(async function* () {
    const { entity, classification } = yield* planAccountMovement(deps, input, type, source);

    const locale = await deps.locale();
    const tagLinks = await resolveTagLinks(deps, entity.id, input.tags);
    const persist = [
      ...withMerchant([persistence.insert({ entity: TRANSACTION_ENTITY_TAG, model: entity })], entity.refs.merchantKey),
      ...(tagLinks ? [tagLinks.persistable] : []),
    ];
    const response = (outcomes: PersistOutcome[]): ClassifiedUpsertResult => {
      const result = buildUpsertResult(outcomes, classification, locale);
      return tagLinks
        ? { ...result, transaction: overlayResolvedTags(result.transaction, tagLinks.tags, outcomes) }
        : result;
    };
    return ok({ persist, response });
  });

export const addAccountExpense = (
  deps: Deps,
  input: AddAccountMovement,
  source: TransactionSource,
): ResultAsync<FlowOutcome<ClassifiedUpsertResult>, AppError> =>
  addAccountMovement(deps, input, MovementType.enum.expense, source);

export const addAccountIncome = (
  deps: Deps,
  input: AddAccountMovement,
  source: TransactionSource,
): ResultAsync<FlowOutcome<ClassifiedUpsertResult>, AppError> =>
  addAccountMovement(deps, input, MovementType.enum.income, source);

// Single-source: every item belongs to the ONE account named in `input.account` (or unattached).
export const importAccountStatement = async (
  deps: Deps,
  input: ImportAccountStatement,
  source: TransactionSource,
): Promise<StatementImportPlan<ImportAccountStatementItem, ClassifiedUpsertResult>> => {
  // A not-found account name, or an unattached statement, falls back to USD decimals here —
  // affects only the idempotency key's rounding; addAccountExpense/Income re-resolves the real
  // account, currency, and any notFound error independently per line. An unattached statement's
  // per-item currency override isn't consulted for this fallback (out of scope).
  const [accountResult, currencies] = await Promise.all([
    input.account ? resolveAccountRef(deps, input.account) : null,
    deps.currencies.list(),
  ]);
  const decimalsFor = decimalsLookup(currencies);
  const decimals = accountResult
    ? accountResult.match(
        (account) => decimalsFor(account.currency),
        () => decimalsFor(CurrencyCode.enum.USD),
      )
    : decimalsFor(CurrencyCode.enum.USD);
  const lines = defaultStatementLines(toIsoDate(deps.clock()), input.items, input.rawInput, decimals);
  // Resolves locale once for the whole import rather than once per line: every line's flow reads
  // deps.locale() to build its localized response, so overriding it here to the same in-flight
  // promise keeps every item's labels consistent even if the process-level locale cache resets
  // mid-import.
  const localePromise = deps.locale();
  const cachedDeps: Deps = { ...deps, locale: () => localePromise };
  const flowFor = (line: (typeof lines)[number]) => (): ResultAsync<FlowOutcome<ClassifiedUpsertResult>, AppError> => {
    const movement = { ...R.omit(line, ['type']), account: input.account };
    return line.type === MovementType.enum.expense
      ? addAccountExpense(cachedDeps, movement, source)
      : addAccountIncome(cachedDeps, movement, source);
  };
  return { lines, flowFor };
};

/**
 * Update an account transaction: asserts every leg the target has is one of this aggregate's own
 * account types (`assertAccountOwnedLegs`) — a transaction with a leg outside that scope is
 * rejected with a redirect to `update_card_transaction` — then enforces transfer mutability, and
 * merges the result onto `existing` to build the full desired end-state entity the shell applies
 * as a version-guarded update. Merchant learning (a correction strengthens the merchant→category
 * association) is composed into the SAME `persist` batch via `withMerchantLearning` — not a side
 * effect performed from `response` — so it commits only when the update does, and never fires on
 * a version-conflict attempt that gets rolled back and retried.
 */
export const updateAccountTransaction = (
  deps: Deps,
  input: UpdateAccountTransaction,
): ResultAsync<FlowOutcome<TransactionView>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const isAccountOwned = yield* assertAccountOwnedLegs(deps, existing);
    yield* guard(isAccountOwned, transactionErrors.wrongTool(TransactionTool.updateCardTransaction));
    yield* guardTransferMutability(existing, input);

    const { account, effectiveType, categorySelection } = yield* decideTransactionUpdate(deps, input, existing);
    const categoryId = categorySelection?.categoryId ?? existing.categoryId;
    const subCategoryId = categorySelection ? categorySelection.subCategoryId : existing.subCategoryId;
    const isUserCorrection = !!categorySelection;

    const entity: TransactionEntity = {
      id: existing.id,
      description: input.description ?? existing.description,
      amount: input.amount ?? existing.amount,
      type: effectiveType ?? existing.type,
      status: existing.status,
      date: input.date ?? existing.date,
      currency: account?.currency ?? existing.currency,
      source: existing.source,
      idempotencyKey: existing.idempotencyKey,
      classification: isUserCorrection
        ? { method: ClassificationMethod.enum.user, confidence: 1 }
        : existing.classification,
      rawInput: existing.rawInput,
      note: input.note !== undefined ? (input.note === '' ? undefined : input.note) : existing.note,
      refs: {
        accountId: account?.id ?? existing.accountId,
        toAccountId: existing.toAccountId,
        cardId: existing.cardId,
        billId: existing.billId,
        categoryId,
        subCategoryId,
        merchantKey: existing.merchant,
      },
    };

    const locale = await deps.locale();
    const merchantCorrection = resolveMerchantCorrection(existing, categoryId);
    const tagLinks = await resolveTagLinks(deps, entity.id, input.tags);
    const persist: Persistable[] = [
      ...withMerchantLearning(
        [persistence.update({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, version: existing.version } })],
        merchantCorrection,
      ),
      ...(tagLinks ? [tagLinks.persistable] : []),
    ];
    const response = (outcomes: PersistOutcome[]): TransactionView => {
      const result = buildTransactionView(outcomes, locale);
      return tagLinks ? overlayResolvedTags(result, tagLinks.tags, outcomes) : result;
    };
    return ok({ persist, response });
  });

/**
 * Delete an account transaction: same ownership guard as updateAccountTransaction, then a dry-run
 * preview (no writes at all — an empty `persist` batch) or a version-guarded remove the shell
 * applies.
 */
export const deleteAccountTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<FlowOutcome<DeleteTransactionResult>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const isAccountOwned = yield* assertAccountOwnedLegs(deps, existing);
    yield* guard(isAccountOwned, transactionErrors.wrongTool(TransactionTool.deleteCardTransaction));

    const locale = await deps.locale();
    const labeled = addLocalizedLabels(existing, locale);

    if (!input.confirm) {
      return ok({
        persist: [],
        response: {
          deleted: false as const,
          dryRun: true as const,
          wouldDelete: labeled,
          hint: DELETE_TRANSACTION_CONFIRM_HINT,
        },
      });
    }

    const persist = [
      persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: existing.id, version: existing.version }),
    ];
    return ok({ persist, response: { deleted: true as const, transaction: labeled } });
  });
