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
} from '../../logic/transaction.js';
import {
  accountErrors,
  type Account,
  type AddAccountMovement,
  type ImportAccountStatement,
  type ImportAccountStatementItem,
  type UpdateAccountTransaction,
} from '../../models/account.js';
import type { FlowOutcome, Persistable, PersistOutcome } from '@rfc0/effect-runner';
import {
  DELETE_TRANSACTION_CONFIRM_HINT,
  TRANSACTION_ENTITY_TAG,
  transactionErrors,
  MovementType,
  type NewTransactionPlan,
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

const assertAccountOwnedLegs = (
  deps: Deps,
  tx: Pick<TransactionView, 'accountId' | 'toAccountId'>,
): ResultAsync<boolean, AppError> =>
  resolveLegAccounts(deps, tx).map((legs) => legs.every((account) => isAccountOwnedType(account.type)));

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

export const importAccountStatement = async (
  deps: Deps,
  input: ImportAccountStatement,
  source: TransactionSource,
): Promise<StatementImportPlan<ImportAccountStatementItem, ClassifiedUpsertResult>> => {
  const lines = defaultStatementLines(toIsoDate(deps.clock()), input.items, input.rawInput);
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
