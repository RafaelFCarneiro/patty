// Account aggregate: owns the account-movement entry points. Validates (category/sub-category
// exclusivity, non-credit account), then hands the write off as a `Persistable` — the core never
// depends on this module (the reverse is fine and expected).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertNonCreditType, guardTransferMutability, isAccountOwnedType } from '../../logic/account.js';
import { resolveCurrency } from '../../logic/money.js';
import { resolveMerchantCorrection, withMerchant, withMerchantLearning } from '../../logic/merchant.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { overlayResolvedTags } from '../../logic/tag.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  buildTransactionView,
  buildUpsertResult,
  defaultStatementLines,
  mergePatch,
  planNewTransaction,
  type NewTransactionPlan,
} from '../../logic/transaction.js';
import {
  accountErrors,
  type Account,
  type AddAccountMovement,
  type ImportAccountStatement,
  type ImportAccountStatementItem,
  type UpdateAccountTransaction,
} from '../../models/account.js';
import { type FlowOutcome, type Persistable, type PersistOutcome } from '@rfc0/effect-runner';
import {
  DELETE_TRANSACTION_CONFIRM_HINT,
  TRANSACTION_ENTITY_TAG,
  transactionErrors,
  MovementType,
  type ClassifiedUpsertResult,
  type DeleteTransactionResult,
  type TransactionSource,
  type TransactionView,
} from '../../models/transaction.js';
import { Remedy } from '../../models/remedy.js';
import type { Deps } from '../deps.js';
import {
  matchCandidatesFor,
  resolveAccountRef,
  resolveDecimals,
  resolveLegAccounts,
  resolveTagLinks,
} from '../resolve.js';
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

/** The account a movement is funded from, or null for an unattached movement. A credit account is the
 *  card flow's to post to, never this one's. */
const resolveFundingAccount = (deps: Deps, ref: string | undefined): ResultAsync<Account | null, AppError> =>
  safeTry(async function* () {
    if (!R.isNonNullish(ref)) return ok(null);
    const account = yield* resolveAccountRef(deps, ref);
    yield* guard(assertNonCreditType(account.type), accountErrors.creditPostRejected);
    return ok(account);
  });

const planAccountMovement = (
  deps: Deps,
  input: AddAccountMovement,
  type: MovementType,
  source: TransactionSource,
): ResultAsync<NewTransactionPlan, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategory);

    const account = yield* resolveFundingAccount(deps, input.account);
    const currency = resolveCurrency(account, input);
    const categorySelection = yield* resolveCategorySelection(deps, input, type);

    return ok(
      planNewTransaction({
        id: deps.newId(),
        today: toIsoDate(deps.clock()),
        input,
        type,
        source,
        currency,
        decimals: await resolveDecimals(deps, currency),
        funding: { refs: { accountId: account?.id }, sourceId: account?.id },
        categorySelection,
        candidates: await matchCandidatesFor(deps, input.description, categorySelection),
        keepsUnmatchedMerchant: true,
      }),
    );
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
    const { entity, classification, idempotencyKey } = yield* planAccountMovement(deps, input, type, source);

    const locale = await deps.locale();
    const tagLinks = await resolveTagLinks(deps, entity.id, input.tags);
    const persist = [
      ...withMerchant(
        [persistence.insert({ entity: TRANSACTION_ENTITY_TAG, model: entity, idempotencyKey })],
        entity.refs.merchantKey,
      ),
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
  const lines = defaultStatementLines(toIsoDate(deps.clock()), input.items, input.rawInput);
  // Cached once for the whole batch — every line's own flow reads locale/currencies, and refetching
  // per line would mean N identical currency-list queries for an N-line import.
  const localePromise = deps.locale();
  const currenciesPromise = deps.currencies.list();
  const cachedDeps: Deps = {
    ...deps,
    locale: () => localePromise,
    currencies: { ...deps.currencies, list: () => currenciesPromise },
  };
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
 * rejected with a redirect to the card-transaction update — then enforces transfer mutability, and
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
    yield* guard(isAccountOwned, transactionErrors.wrongOperation(Remedy.enum.update_card_transaction));
    yield* guardTransferMutability(existing, input);

    const { account, categorySelection } = yield* decideTransactionUpdate(deps, input, existing);
    const entity = mergePatch(existing, input, categorySelection, { account });

    const locale = await deps.locale();
    const merchantCorrection = resolveMerchantCorrection(existing, entity.refs.categoryId);
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
    yield* guard(isAccountOwned, transactionErrors.wrongOperation(Remedy.enum.delete_card_transaction));

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
