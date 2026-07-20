// Credit-card aggregate (ADR-016 step 2): owns the card-purchase entry point and the bill-policy
// side of update/delete for card transactions. Hands writes off as `Persistable`s (ADR-021) — the
// core never depends on this module (the reverse is fine and expected).

import { ok, safeTry, type Result, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import {
  assertBillPeriodPaired,
  billEntityFrom,
  billPeriodForCycle,
  isBillPaid,
  resolveBillPeriod,
  type BillPeriod,
} from '../../logic/bill.js';
import { pickClassification, userClassification } from '../../logic/classify.js';
import { resolveCurrency } from '../../logic/money.js';
import {
  normalizeMerchant,
  resolveMerchantCorrection,
  withMerchant,
  withMerchantLearning,
} from '../../logic/merchant.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  defaultStatementLines,
  defaultStatusFor,
  viewFromOutcome,
} from '../../logic/transaction.js';
import { AccountType } from '../../models/account.js';
import { BILL_ENTITY_TAG, BillStatus, type RawBill } from '../../models/bill.js';
import {
  cardErrors,
  type AddCardPurchase,
  type ImportCardStatement,
  type ImportCardStatementItem,
  type UpdateCardTransaction,
} from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import { type FlowOutcome, type Persistable, type PersistOutcome } from '../../models/persistable.js';
import {
  ClassificationMethod,
  DELETE_TRANSACTION_CONFIRM_HINT,
  TRANSACTION_ENTITY_TAG,
  transactionErrors,
  TransactionTool,
  type ClassifiedUpsertResult,
  type ClassifyOutcome,
  type DeleteTransactionResult,
  type RawTransactionView,
  type TransactionEntity,
  type TransactionSource,
  type TransactionView,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveCardRef, resolveLegAccounts, resolveTagLinks } from '../resolve.js';
import type { StatementImportPlan } from '../transaction/bulk.js';
import { decideTransactionUpdate, resolveCategorySelection } from '../transaction/core.js';

/** True when a leg of the transaction is the card's own `credit` account (ADR-010/ADR-020) — a
 *  card purchase's `accountId`, or the bill-payment transfer's `toAccountId`. */
const assertCreditAccountLeg = (
  deps: Deps,
  tx: Pick<TransactionView, 'accountId' | 'toAccountId'>,
): ResultAsync<boolean, AppError> =>
  resolveLegAccounts(deps, tx).map((legs) => legs.some((account) => account.type === AccountType.enum.credit));

/** billId with no cardId is definitionally the bill-payment transfer (pay_bill's own row) — owned
 *  exclusively by pay_bill/revert_bill_payment. */
const resolveOwnCardId = (existing: Pick<TransactionView, 'cardId'>): Result<string, AppError> =>
  okOr(existing.cardId, cardErrors.paidBillImmutable);

/** Version-guarded no-op update of a bill's current fields — a CAS guard: if a concurrent write
 *  (e.g. `pay_bill`) bumped the version first, the batch rolls back and retries. */
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

/** Insert-or-touch for a bill cycle (replaces the old repo-level `ensureAndAttach`): touches
 *  `existingBill` if the cycle already has one, else inserts a fresh `open` bill. Returns the id
 *  the transaction should reference. */
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

type CardPurchasePlan = {
  entity: TransactionEntity;
  classification: ClassifyOutcome;
  billPeriod: BillPeriod;
  existingBill: RawBill | null;
  cardId: string;
};

// billId is left unset — addCardPurchase (below) resolves it against existingBill.
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
    const date = input.date ?? today;
    const status = input.status ?? defaultStatusFor(date, today);

    const billPeriod = resolveBillPeriod(input.billMonth, input.billYear, date, card.closingDay, card.dueDay);
    const existingBill = await deps.bills.findByCycle(card.id, billPeriod.month, billPeriod.year);
    yield* guard(!existingBill || !isBillPaid(existingBill), cardErrors.paidBillImmutable);

    const categorySelection = yield* resolveCategorySelection(deps, input, input.type);
    const classification: ClassifyOutcome = categorySelection
      ? userClassification({ id: categorySelection.categoryId, name: categorySelection.categoryName })
      : pickClassification(await deps.merchants.matchCandidates(normalizeMerchant(input.description)));
    const subCategoryId = categorySelection?.subCategoryId;

    const entity: TransactionEntity = {
      id: deps.newId(),
      description: input.description,
      amount: input.amount,
      type: input.type,
      status,
      date,
      currency: resolveCurrency(card, input),
      source,
      idempotencyKey: input.idempotencyKey,
      classification,
      rawInput: input.rawInput,
      note: input.note,
      refs: {
        accountId: card.accountId,
        cardId: card.id,
        categoryId: classification.categoryId,
        subCategoryId,
        merchantKey: classification.merchantKey,
      },
    };

    return ok({ entity, classification, billPeriod, existingBill, cardId: card.id });
  });

export const addCardPurchase = (
  deps: Deps,
  input: AddCardPurchase,
  source: TransactionSource,
): ResultAsync<FlowOutcome<ClassifiedUpsertResult>, AppError> =>
  safeTry(async function* () {
    const { entity, classification, billPeriod, existingBill, cardId } = yield* planCardPurchase(deps, input, source);
    const { billId, billPersistable } = resolveBillWrite(deps.newId, cardId, billPeriod, existingBill);
    const { persistable: tagPersistable, tags } = await resolveTagLinks(deps, entity.idempotencyKey, input.tags ?? []);

    // Bill leads, transaction trails — its bill_id FK must resolve within the same batch.
    const persist: Persistable[] = [
      billPersistable,
      ...withMerchant(
        [
          persistence.insert({
            entity: TRANSACTION_ENTITY_TAG,
            model: { ...entity, refs: { ...entity.refs, billId } },
          }),
        ],
        entity.refs.merchantKey,
      ),
      tagPersistable,
    ];

    const locale = await deps.locale();
    // `tags` is composed onto the DB round-trip's view, not read off it — see resolveTagLinks's
    // doc comment (the tag-set write applies later in the batch than this row's own read-back).
    const response = (outcomes: PersistOutcome[]): ClassifiedUpsertResult => {
      const outcome = persistence.outcomeFor(TRANSACTION_ENTITY_TAG, outcomes);
      return { transaction: { ...viewFromOutcome(outcome, locale), tags }, created: outcome.applied, classification };
    };
    return ok({ persist, response });
  });

// Single-source: every item is a purchase on the ONE card named in `input.card`. Because the
// shell re-invokes each line's flow only after the previous line committed, two lines landing on
// the same new bill cycle simply share it — no within-batch dedup needed.
export const importCardStatement = (
  deps: Deps,
  input: ImportCardStatement,
  source: TransactionSource,
): StatementImportPlan<ImportCardStatementItem, ClassifiedUpsertResult> => {
  const lines = defaultStatementLines(toIsoDate(deps.clock()), input.items, input.rawInput);
  // Resolves locale once for the whole import rather than once per line: every line's flow reads
  // deps.locale() to build its localized response, so overriding it here to the same in-flight
  // promise keeps every item's labels consistent even if the process-level locale cache resets
  // mid-import.
  const localePromise = deps.locale();
  const cachedDeps: Deps = { ...deps, locale: () => localePromise };
  const flowFor = (line: (typeof lines)[number]) => () =>
    addCardPurchase(cachedDeps, { ...line, card: input.card }, source);
  return { lines, flowFor };
};

type BillReassignment = { reassignedBillId: string | undefined; billPersistables: Persistable[] };

/** Settles a `billMonth`/`billYear` reassignment: rejects a paid current or target bill, then
 *  resolves both bills' writes, deduped to one touch when they're the same cycle. A no-op
 *  (`reassignedBillId: undefined`, no persistables) when no reassignment was requested. */
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

/** Update a card transaction (ADR-020): rejects the wrong tool and the bill-payment transfer
 *  itself, settles any bill reassignment, and merges the remaining patch onto `existing`. Never
 *  reasons about transfer mutability — the only transfer this aggregate sees is blocked outright
 *  above, by bill-process policy. */
export const updateCardTransaction = (
  deps: Deps,
  input: UpdateCardTransaction,
): ResultAsync<FlowOutcome<TransactionView>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const isCreditOwned = yield* assertCreditAccountLeg(deps, existing);
    yield* guard(isCreditOwned, transactionErrors.wrongTool(TransactionTool.updateAccountTransaction));
    const cardId = yield* resolveOwnCardId(existing);

    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    yield* guard(assertBillPeriodPaired(input), cardErrors.billPeriodIncomplete);
    // A card purchase has no independent `account` to reassign — it's always funded by the card's
    // own internal liability account (ADR-010).
    yield* guard(!R.isNonNullish(input.account), cardErrors.accountChangeRejectedForCard);

    const { reassignedBillId, billPersistables } = yield* resolveBillReassignment(deps, cardId, existing, input);

    const { categorySelection } = yield* decideTransactionUpdate(
      deps,
      R.omit(input, ['billMonth', 'billYear']),
      existing,
    );
    const categoryId = categorySelection?.categoryId ?? existing.categoryId;
    const subCategoryId = categorySelection ? categorySelection.subCategoryId : existing.subCategoryId;
    const isUserCorrection = !!categorySelection;

    const entity: TransactionEntity = {
      id: existing.id,
      description: input.description ?? existing.description,
      amount: input.amount ?? existing.amount,
      type: input.type ?? existing.type,
      status: existing.status,
      date: input.date ?? existing.date,
      currency: existing.currency,
      source: existing.source,
      idempotencyKey: existing.idempotencyKey,
      classification: isUserCorrection
        ? { method: ClassificationMethod.enum.user, confidence: 1 }
        : existing.classification,
      rawInput: existing.rawInput,
      note: input.note !== undefined ? (input.note === '' ? undefined : input.note) : existing.note,
      refs: {
        accountId: existing.accountId,
        toAccountId: existing.toAccountId,
        cardId: existing.cardId,
        billId: reassignedBillId ?? existing.billId,
        categoryId,
        subCategoryId,
        merchantKey: existing.merchant,
      },
    };

    const merchantCorrection = resolveMerchantCorrection(existing, categoryId);
    const { persistable: tagPersistable, tags } = await resolveTagLinks(
      deps,
      entity.idempotencyKey,
      input.tags ?? existing.tags,
    );
    const persist: Persistable[] = [
      ...withMerchantLearning(billPersistables, merchantCorrection),
      persistence.update({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, version: existing.version } }),
      tagPersistable,
    ];

    const locale = await deps.locale();
    // `tags` is composed onto the DB round-trip's view, not read off it — see resolveTagLinks's
    // doc comment (the tag-set write applies later in the batch than this row's own read-back).
    const response = (outcomes: PersistOutcome[]): TransactionView => ({
      ...viewFromOutcome(persistence.outcomeFor(TRANSACTION_ENTITY_TAG, outcomes), locale),
      tags,
    });
    return ok({ persist, response });
  });

/** Delete a card transaction (ADR-020): rejects the wrong tool and a transaction whose bill is
 *  paid — which also covers the bill-payment transfer, whose own billId is always the bill it
 *  paid. A confirmed delete version-guards that bill too, not just re-checking its paid status. */
export const deleteCardTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<FlowOutcome<DeleteTransactionResult>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const isCreditOwned = yield* assertCreditAccountLeg(deps, existing);
    yield* guard(isCreditOwned, transactionErrors.wrongTool(TransactionTool.deleteAccountTransaction));

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
