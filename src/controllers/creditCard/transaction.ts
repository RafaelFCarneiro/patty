import { ok, safeTry, type Result, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import {
  assertBillPeriodPaired,
  billEntityFrom,
  billPeriodKey,
  billPeriodForCycle,
  isBillPaid,
  resolveBillPeriod,
} from '../../logic/bill.js';
import { resolveCurrency } from '../../logic/money.js';
import { resolveMerchantCorrection, withMerchant, withMerchantLearning } from '../../logic/merchant.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { overlayResolvedTags } from '../../logic/tag.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  defaultStatementLines,
  mergePatch,
  planNewTransaction,
  viewFromOutcome,
} from '../../logic/transaction.js';
import { AccountType } from '../../models/account.js';
import { BILL_ENTITY_TAG, BillStatus, type BillPeriod, type RawBill } from '../../models/bill.js';
import {
  cardErrors,
  type AddCardPurchase,
  type CardPurchasePlan,
  type ImportCardStatement,
  type ImportCardStatementItem,
  type UpdateCardTransaction,
  type BillReassignment,
} from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import { type FlowOutcome, type Persistable, type PersistOutcome } from '@rfc0/effect-runner';
import {
  DELETE_TRANSACTION_CONFIRM_HINT,
  TRANSACTION_ENTITY_TAG,
  transactionErrors,
  type ClassifiedUpsertResult,
  type DeleteTransactionResult,
  type RawTransactionView,
  type TransactionSource,
  type TransactionView,
} from '../../models/transaction.js';
import { Remedy } from '../../models/remedy.js';
import type { Deps } from '../deps.js';
import {
  matchCandidatesFor,
  resolveCardRef,
  resolveDecimals,
  resolveLegAccounts,
  resolveTagLinks,
} from '../resolve.js';
import type { StatementImportPlan } from '../transaction/bulk.js';
import { decideTransactionUpdate, resolveCategorySelection } from '../transaction/core.js';

const assertCreditAccountLeg = (
  deps: Deps,
  tx: Pick<TransactionView, 'accountId' | 'toAccountId'>,
): ResultAsync<boolean, AppError> =>
  resolveLegAccounts(deps, tx).map((legs) => legs.some((account) => account.type === AccountType.enum.credit));

const resolveOwnCardId = (existing: Pick<TransactionView, 'cardId'>): Result<string, AppError> =>
  okOr(existing.cardId, cardErrors.paidBillImmutable);

const touchBill = (bill: RawBill): Persistable =>
  persistence.update({ entity: BILL_ENTITY_TAG, model: billEntityFrom(bill) });

const openBillInsert = (billId: string, cardId: string, period: BillPeriod): Persistable =>
  persistence.insert({
    entity: BILL_ENTITY_TAG,
    model: {
      id: billId,
      creditCardId: cardId,
      month: period.month,
      year: period.year,
      closeDate: period.closeDate,
      dueDate: period.dueDate,
      status: BillStatus.enum.open,
    },
  });

const resolveBillWrite = (
  newId: () => string,
  cardId: string,
  period: BillPeriod,
  existingBill: RawBill | null,
): { billId: string; billPersistable: Persistable } => {
  if (existingBill) return { billId: existingBill.id, billPersistable: touchBill(existingBill) };
  const billId = newId();
  return { billId, billPersistable: openBillInsert(billId, cardId, period) };
};

const planCardPurchase = (
  deps: Deps,
  input: AddCardPurchase,
  source: TransactionSource,
): ResultAsync<CardPurchasePlan, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategory);
    yield* guard(assertBillPeriodPaired(input), cardErrors.billPeriodIncomplete);

    const card = yield* resolveCardRef(deps, input.card);
    const today = toIsoDate(deps.clock());
    const currency = resolveCurrency(card, input);

    const billPeriod = resolveBillPeriod(
      input.billMonth,
      input.billYear,
      input.date ?? today,
      card.closingDay,
      card.dueDay,
    );
    const existingBill = await deps.bills.findByCycle(card.id, billPeriod.month, billPeriod.year);
    yield* guard(!existingBill || !isBillPaid(existingBill), cardErrors.paidBillImmutable);

    const categorySelection = yield* resolveCategorySelection(deps, input, input.type);
    const plan = planNewTransaction({
      id: deps.newId(),
      today,
      input,
      type: input.type,
      source,
      currency,
      decimals: await resolveDecimals(deps, currency),
      funding: {
        refs: { accountId: card.accountId, cardId: card.id },
        sourceId: card.id,
        billPeriodKey: billPeriodKey(billPeriod),
      },
      categorySelection,
      candidates: await matchCandidatesFor(deps, input.description, categorySelection),
      keepsUnmatchedMerchant: false,
    });

    return ok({ ...plan, billPeriod, existingBill, cardId: card.id });
  });

export const addCardPurchase = (
  deps: Deps,
  input: AddCardPurchase,
  source: TransactionSource,
): ResultAsync<FlowOutcome<ClassifiedUpsertResult>, AppError> =>
  safeTry(async function* () {
    const { entity, classification, billPeriod, existingBill, cardId, idempotencyKey } = yield* planCardPurchase(
      deps,
      input,
      source,
    );
    const { billId, billPersistable } = resolveBillWrite(deps.newId, cardId, billPeriod, existingBill);
    const tagLinks = await resolveTagLinks(deps, entity.id, input.tags);

    // The bill leads: the transaction's bill_id FK must resolve within the same batch.
    const persist: Persistable[] = [
      billPersistable,
      ...withMerchant(
        [
          persistence.insert({
            entity: TRANSACTION_ENTITY_TAG,
            model: { ...entity, refs: { ...entity.refs, billId } },
            idempotencyKey,
          }),
        ],
        entity.refs.merchantKey,
      ),
      ...(tagLinks ? [tagLinks.persistable] : []),
    ];

    const locale = await deps.locale();
    const response = (outcomes: PersistOutcome[]): ClassifiedUpsertResult => {
      const outcome = persistence.outcomeFor(TRANSACTION_ENTITY_TAG, outcomes);
      const view = viewFromOutcome(outcome, locale);
      return {
        transaction: tagLinks ? overlayResolvedTags(view, tagLinks.tags, outcomes) : view,
        created: outcome.applied,
        classification,
      };
    };
    return ok({ persist, response });
  });

export const importCardStatement = async (
  deps: Deps,
  input: ImportCardStatement,
  source: TransactionSource,
): Promise<StatementImportPlan<ImportCardStatementItem, ClassifiedUpsertResult>> => {
  const lines = defaultStatementLines(toIsoDate(deps.clock()), input.items, input.rawInput);
  const localePromise = deps.locale();
  const currenciesPromise = deps.currencies.list();
  const cachedDeps: Deps = {
    ...deps,
    locale: () => localePromise,
    currencies: { ...deps.currencies, list: () => currenciesPromise },
  };
  const flowFor = (line: (typeof lines)[number]) => () =>
    addCardPurchase(cachedDeps, { ...line, card: input.card }, source);
  return { lines, flowFor };
};

const resolveBillReassignment = (
  deps: Deps,
  cardId: string,
  existing: Pick<RawTransactionView, 'billId'>,
  input: Pick<UpdateCardTransaction, 'billMonth' | 'billYear'>,
): ResultAsync<BillReassignment, AppError> =>
  safeTry(async function* () {
    if (!R.isNonNullish(input.billMonth) || !R.isNonNullish(input.billYear)) {
      return ok({ reassignedBillId: undefined, billPersistables: [] });
    }

    const currentBill = existing.billId ? await deps.bills.findById(existing.billId) : null;
    yield* guard(!currentBill || !isBillPaid(currentBill), cardErrors.paidBillImmutable);

    const card = yield* okOr(await deps.creditCards.findById(cardId), notFound('card', cardId, []));
    const period = billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay);
    const targetBill = await deps.bills.findByCycle(card.id, period.month, period.year);
    yield* guard(!targetBill || !isBillPaid(targetBill), cardErrors.paidBillImmutable);

    const { billId, billPersistable } = resolveBillWrite(deps.newId, card.id, period, targetBill);
    const sameCycle = currentBill?.id === billId;
    const billPersistables = [billPersistable, ...(currentBill && !sameCycle ? [touchBill(currentBill)] : [])];

    return ok({ reassignedBillId: billId, billPersistables });
  });

const loadOwnCardTransaction = (
  deps: Deps,
  id: string,
): ResultAsync<{ existing: RawTransactionView; cardId: string }, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(id), transactionErrors.notFound(id));
    const isCreditOwned = yield* assertCreditAccountLeg(deps, existing);
    yield* guard(isCreditOwned, transactionErrors.wrongOperation(Remedy.enum.update_account_transaction));
    return ok({ existing, cardId: yield* resolveOwnCardId(existing) });
  });

const guardCardPatch = (input: UpdateCardTransaction): Result<void, AppError> =>
  safeTry(function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    yield* guard(assertBillPeriodPaired(input), cardErrors.billPeriodIncomplete);
    yield* guard(!R.isNonNullish(input.account), cardErrors.accountChangeRejectedForCard);
    return ok();
  });

export const updateCardTransaction = (
  deps: Deps,
  input: UpdateCardTransaction,
): ResultAsync<FlowOutcome<TransactionView>, AppError> =>
  safeTry(async function* () {
    const { existing, cardId } = yield* loadOwnCardTransaction(deps, input.id);
    yield* guardCardPatch(input);

    const { reassignedBillId, billPersistables } = yield* resolveBillReassignment(deps, cardId, existing, input);
    const patch = R.omit(input, ['billMonth', 'billYear']);
    const { categorySelection } = yield* decideTransactionUpdate(deps, patch, existing);
    const entity = mergePatch(existing, input, categorySelection, { billId: reassignedBillId });

    const merchantCorrection = resolveMerchantCorrection(existing, entity.refs.categoryId);
    const tagLinks = await resolveTagLinks(deps, entity.id, input.tags);
    const persist: Persistable[] = [
      ...withMerchantLearning(billPersistables, merchantCorrection),
      persistence.update({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, version: existing.version } }),
      ...(tagLinks ? [tagLinks.persistable] : []),
    ];

    const locale = await deps.locale();
    const response = (outcomes: PersistOutcome[]): TransactionView => {
      const view = viewFromOutcome(persistence.outcomeFor(TRANSACTION_ENTITY_TAG, outcomes), locale);
      return tagLinks ? overlayResolvedTags(view, tagLinks.tags, outcomes) : view;
    };
    return ok({ persist, response });
  });

export const deleteCardTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<FlowOutcome<DeleteTransactionResult>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const isCreditOwned = yield* assertCreditAccountLeg(deps, existing);
    yield* guard(isCreditOwned, transactionErrors.wrongOperation(Remedy.enum.delete_account_transaction));

    const bill = existing.billId ? await deps.bills.findById(existing.billId) : null;
    yield* guard(!bill || !isBillPaid(bill), cardErrors.paidBillImmutable);

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

    const persist: Persistable[] = [
      ...(bill ? [touchBill(bill)] : []),
      persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: existing.id, version: existing.version }),
    ];
    return ok({ persist, response: { deleted: true as const, transaction: labeled } });
  });
