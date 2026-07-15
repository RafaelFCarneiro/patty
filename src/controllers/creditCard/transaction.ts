// Credit-card aggregate (ADR-016 step 2): owns the card-purchase entry point and the bill-policy
// side of update/delete for card transactions. Validates (paid-bill immutability, cycle
// resolution), then hands the write off as a `Persistable` (ADR-021 phase 2b) — the core never
// depends on this module (the reverse is fine and expected).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import {
  assertBillPeriodPaired,
  billEntityFrom,
  billPeriodFor,
  billPeriodForCycle,
  isBillPaid,
  type BillPeriod,
} from '../../logic/bill.js';
import { pickClassification, userClassification } from '../../logic/classify.js';
import { resolveCurrency } from '../../logic/money.js';
import { normalizeMerchant, resolveMerchantCorrection } from '../../logic/merchant.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import {
  addLocalizedLabels,
  assertExclusiveCategorySubCategory,
  defaultStatusFor,
  viewFromOutcome,
} from '../../logic/transaction.js';
import { AccountType } from '../../models/account.js';
import { BILL_ENTITY_TAG, BillStatus, type RawBill } from '../../models/bill.js';
import {
  cardErrors,
  type AddCardPurchase,
  type ImportCardStatement,
  type UpdateCardTransaction,
} from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import { MERCHANT_CATEGORY_ENTITY_TAG } from '../../models/merchant.js';
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
  type TransactionEntity,
  type TransactionSource,
  type TransactionView,
} from '../../models/transaction.js';
import type { BulkResult } from '../../logic/transaction.js';
import type { Deps } from '../deps.js';
import { resolveCardRef, resolveLegAccounts } from '../resolve.js';
import { runStatementImport } from '../transaction/bulk.js';
import { decideTransactionUpdate, resolveCategorySelection } from '../transaction/core.js';

/**
 * Repo-touching precondition (ADR-020): true when a leg of the transaction is a `credit` account —
 * this aggregate's own positive ownership test (a card purchase's `accountId`, or the bill-payment
 * transfer's `toAccountId`, is the card's internal account). The account aggregate does not share
 * this predicate; it asks its own, different question (`assertAccountOwnedLegs`).
 */
const assertCreditAccountLeg = (
  deps: Deps,
  tx: Pick<TransactionView, 'accountId' | 'toAccountId'>,
): ResultAsync<boolean, AppError> =>
  resolveLegAccounts(deps, tx).map((legs) => legs.some((account) => account.type === AccountType.enum.credit));

/** A version-guarded update `Persistable` that re-writes a bill's current field values unchanged —
 *  it exists purely to CAS-guard on `version`: if a concurrent write (e.g. `pay_bill`) bumped the
 *  bill between this flow's read and the shell's apply, the guard fails, the whole batch rolls
 *  back, and `withUnitOfWork` re-invokes the flow for a fresh read (rule 4) — "guard what you
 *  validated". */
const touchBill = (bill: RawBill): Persistable =>
  persistence.update({ entity: BILL_ENTITY_TAG, model: billEntityFrom(bill) });

/**
 * Resolves the write for a bill cycle — the "ensure" decision that used to live in the repo
 * (`bills.ensureAndAttach`), now made by the domain and expressed as a `Persistable` (ADR-021
 * phase 2b): a version-guarded touch of `existingBill` if the cycle already has one, or a fresh
 * `open` insert (with a freshly minted id) if not. Returns the bill id the transaction should
 * reference either way — never a separate "attach" step, so there is no orphan to self-heal.
 */
const resolveBillWrite = (
  newId: () => string,
  cardId: string,
  period: BillPeriod,
  existingBill: RawBill | null,
): { billId: string; billPersistable: Persistable } => {
  if (existingBill) return { billId: existingBill.id, billPersistable: touchBill(existingBill) };

  const billId = newId();
  return {
    billId,
    billPersistable: persistence.insert({
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
    }),
  };
};

type CardPurchasePlan = {
  entity: TransactionEntity;
  classification: ClassifyOutcome;
  billPeriod: BillPeriod;
  existingBill: RawBill | null;
  cardId: string;
};

/** Everything addCardPurchase/addCardPurchaseViaRepo decide via injected reads, before either the
 *  FC/IS path or the (bulk-import-only) legacy repo path shapes its own write — validation, card
 *  resolution, the target bill cycle (and its current row, if any), and the full transaction entity
 *  to persist (still missing its `billId`, resolved by each caller against `existingBill`). Pure
 *  decision plus reads, no write: shared by `addCardPurchase` (below) and `addCardPurchaseViaRepo`. */
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

    // Resolve the target bill period up front (explicit override or cycle-based auto-assignment) and
    // reject onto a paid bill before doing any category/merchant resolution work — a request that's
    // going to be rejected shouldn't pay for that work first, and there is no orphan, unattached row
    // to worry about leaving behind either way (the transaction row carries billId at insert).
    const billPeriod: BillPeriod =
      input.billMonth !== undefined && input.billYear !== undefined
        ? billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay)
        : billPeriodFor(date, card.closingDay, card.dueDay);
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
      tagNames: input.tags ?? [],
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

    // Bill before transaction: a fresh bill insert must already exist, in this same unit-of-work
    // transaction, before the transaction row's own bill_id FK can reference it — so this batch's
    // own entity (the transaction) trails rather than leads (contrast `logic/persistence.ts`'s
    // `firstOutcome`, the usual case); `lastOutcome` is what this flow's response resolves against.
    const persist: Persistable[] = [
      billPersistable,
      persistence.insert({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, refs: { ...entity.refs, billId } } }),
    ];

    const locale = await deps.locale();
    const response = (outcomes: PersistOutcome[]): ClassifiedUpsertResult => {
      const outcome = persistence.lastOutcome(outcomes);
      return { transaction: viewFromOutcome(outcome, locale), created: outcome.applied, classification };
    };
    return ok({ persist, response });
  });

/**
 * Legacy repo-write path — used only by `importCardStatement` below (bulk import isn't converted
 * until ADR-021 phase 3, mirroring `controllers/account/transaction.ts`'s
 * `addAccountMovementViaRepo`). Shares `planCardPurchase`'s decision with the FC/IS `addCardPurchase`
 * above; only the write mechanics differ. The transaction row still carries `billId` at creation
 * (via `deps.bills.ensureOpen`, which folds "create if the cycle has none yet" into one call) — no
 * separate attach step here either, even though the bill-ensure and the transaction-insert aren't
 * atomic with each other on this (temporary, unconverted) path the way the FC/IS batch is.
 */
const addCardPurchaseViaRepo = (
  deps: Deps,
  input: AddCardPurchase,
  source: TransactionSource,
): ResultAsync<ClassifiedUpsertResult, AppError> =>
  safeTry(async function* () {
    const { entity, classification, billPeriod, existingBill, cardId } = yield* planCardPurchase(deps, input, source);
    const bill = existingBill ?? (await deps.bills.ensureOpen(cardId, billPeriod, deps.newId()));

    const { transaction, created } = await deps.transactions.create(
      { ...entity, refs: { ...entity.refs, billId: bill.id } },
      entity.tagNames,
    );

    const locale = await deps.locale();
    return ok({ transaction: addLocalizedLabels(transaction, locale), created, classification });
  });

/**
 * Import a credit-card statement (ADR-017 step 2): single-source — every item belongs to the ONE
 * card named in `input.card`, so there is no per-line card to resolve or route. Binds `addCardPurchaseViaRepo`
 * to that fixed card and delegates the generic import plumbing (defaulting, dedup, needs-review
 * flagging) to the shared `runStatementImport` runner.
 */
export const importCardStatement = (
  deps: Deps,
  input: ImportCardStatement,
  source: TransactionSource,
): ResultAsync<BulkResult<AppError>, AppError> =>
  runStatementImport(deps, input.items, input.rawInput, source, (d, line, src) =>
    addCardPurchaseViaRepo(d, { ...line, card: input.card }, src),
  );

/**
 * Update a card transaction (ADR-020/ADR-021 phase 2b): asserts the target involves a `credit`
 * account — a transaction with no `credit` leg is rejected with a redirect to
 * `update_account_transaction`. Validates and settles any bill reassignment (billMonth/billYear),
 * then merges the remaining generic patch (category, description, amount, …) onto `existing` itself
 * — sharing `decideTransactionUpdate`'s reads with the account aggregate's own FC/IS
 * `updateAccountTransaction`. Never reasons about transfer mutability — the only transfer this
 * aggregate ever sees (the bill-payment transfer) is blocked outright below, by bill-process policy,
 * not by transfer-immutability policy. Preserves a pre-existing behavior gap: a plain,
 * non-reassignment edit (e.g. changing amount) is NOT rejected just because the transaction's
 * current bill happens to be paid — only a reassignment (billMonth/billYear given) checks paid
 * status at all, exactly as before this conversion. Merchant learning (a category correction
 * strengthens the merchant→category association) is composed into the SAME `persist` batch as a
 * `MERCHANT_CATEGORY_ENTITY_TAG` insert (rule 5) — placed before the transaction update so the
 * transaction `Persistable` stays last (see `lastOutcome` below) — mirroring
 * `updateAccountTransaction`'s own merchant-learning composition.
 */
export const updateCardTransaction = (
  deps: Deps,
  input: UpdateCardTransaction,
): ResultAsync<FlowOutcome<TransactionView>, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    const isCreditOwned = yield* assertCreditAccountLeg(deps, existing);
    yield* guard(isCreditOwned, transactionErrors.wrongTool(TransactionTool.updateAccountTransaction));

    // A card-owned transaction with no cardId is definitionally the bill-payment transfer
    // (pay_bill's own row: billId set, no cardId — nothing else in the domain has billId without
    // cardId). It's created/removed only by pay_bill/revert_bill_payment (ADR-017 sub-decision 4),
    // so any direct edit — reassignment or otherwise — is rejected outright before the checks below,
    // which assume a real card purchase. `okOr` also narrows `cardId` for reuse in the reassignment
    // branch, replacing what used to be a second, now-unreachable lookup there.
    const cardId = yield* okOr(existing.cardId, cardErrors.paidBillImmutable);

    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    yield* guard(assertBillPeriodPaired(input), cardErrors.billPeriodIncomplete);
    // A card purchase is always funded by the card's own internal liability account (ADR-010) — it
    // has no independent `account` to reassign. Reject rather than silently forwarding `account` to
    // the shared decision below, which would repoint `from_account_id` at an arbitrary account while
    // leaving `cardId`/`billId` untouched: the card's own account balance would stop reflecting the
    // purchase even though the bill total still counts it, and the new account would show a
    // spurious expense.
    yield* guard(!R.isNonNullish(input.account), cardErrors.accountChangeRejectedForCard);

    // Reassignment (billMonth/billYear given): validate up front — never leave the current or target
    // bill in a half-changed state. `Bill` reads happen before any write is built, and every bill
    // this flow touches is version-guarded in the batch below (guard-what-you-validated) — a
    // concurrent `pay_bill` landing between these reads and the shell's apply rolls the whole batch
    // back and re-invokes this flow for a fresh read (rule 4), which then sees `paid` for real.
    let reassignedBillId: string | undefined;
    const billPersistables: Persistable[] = [];
    if (input.billMonth !== undefined && input.billYear !== undefined) {
      const currentBill = existing.billId ? await deps.bills.findById(existing.billId) : null;
      yield* guard(!currentBill || !isBillPaid(currentBill), cardErrors.paidBillImmutable);

      // A stale cardId here would be an internal FK inconsistency (deleting a card cascades to its
      // transactions), not a real user-facing case — but the error, if it ever fires, should name the
      // card that's missing, not the transaction that's present.
      const card = yield* okOr(await deps.creditCards.findById(cardId), notFound('card', cardId, []));
      const period = billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay);
      const targetBill = await deps.bills.findByCycle(card.id, period.month, period.year);
      yield* guard(!targetBill || !isBillPaid(targetBill), cardErrors.paidBillImmutable);

      const resolved = resolveBillWrite(deps.newId, card.id, period, targetBill);
      reassignedBillId = resolved.billId;
      billPersistables.push(resolved.billPersistable);

      // Reassigning onto the SAME cycle it's already on: one touch, not two — a second update on
      // the same row in the same transaction would see the first update's already-bumped version
      // and spuriously conflict.
      if (currentBill && currentBill.id !== resolved.billId) billPersistables.push(touchBill(currentBill));
    }

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
      // A card purchase's currency is always the card's own (fixed at creation) — `account` is
      // rejected above, so there is never a new funding source to re-derive it from.
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
      tagNames: input.tags ?? existing.tags,
    };

    // Learning loop: correcting the category strengthens the merchant→category association —
    // composed into the same atomic batch as the transaction update (rule 5), never a side effect
    // fired from `response`. Inserted before the transaction update, not after, so the transaction
    // `Persistable` stays the batch's LAST element (bill Persistable(s) lead, transaction trails —
    // see the doc comment above); `lastOutcome` below depends on that position.
    const merchantCorrection = resolveMerchantCorrection(existing, categoryId);
    const persist: Persistable[] = [
      ...billPersistables,
      ...(merchantCorrection
        ? [persistence.insert({ entity: MERCHANT_CATEGORY_ENTITY_TAG, model: merchantCorrection })]
        : []),
      persistence.update({ entity: TRANSACTION_ENTITY_TAG, model: { ...entity, version: existing.version } }),
    ];

    const locale = await deps.locale();
    const response = (outcomes: PersistOutcome[]): TransactionView =>
      viewFromOutcome(persistence.lastOutcome(outcomes), locale);
    return ok({ persist, response });
  });

/**
 * Delete a card transaction (ADR-020/ADR-021 phase 2b): asserts the target involves a `credit`
 * account, then paid-bill immutability (which also covers the bill-payment transfer — its own
 * billId is always the bill it paid), then a dry-run preview or a version-guarded remove — guarding
 * the bill too (not just re-checking its paid status), so a concurrent `pay_bill` landing between
 * this read and the shell's apply can't slip a delete onto a now-paid bill.
 */
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
