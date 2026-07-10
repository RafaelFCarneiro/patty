// Credit-card aggregate (ADR-016 step 2): owns the card-purchase entry point and the bill-policy
// side of update/delete for card transactions. Validates (paid-bill immutability, cycle
// resolution), then delegates row persistence to the transaction core — the core never depends on
// this module (the reverse is fine and expected).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { billPeriodFor, billPeriodForCycle, isBillPaid, type BillPeriod } from '../../logic/bill.js';
import { pickClassification, userClassification } from '../../logic/classify.js';
import { normalizeMerchant } from '../../logic/merchant.js';
import { toIsoDate } from '../../logic/period.js';
import {
  addLocalizedLabels,
  assertBillPeriodPaired,
  assertExclusiveCategorySubCategory,
  defaultStatusFor,
  guardTransferMutability,
  resolveCurrency,
  withBillId,
} from '../../logic/transaction.js';
import { type AddCardPurchase } from '../../models/creditCard.js';
import { notFound } from '../../models/error.js';
import {
  transactionErrors,
  type ClassifyOutcome,
  type CreateTransactionResult,
  type DeleteTransactionResult,
  type TransactionSource,
  type TransactionView,
  type UpdateTransaction,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveCardRef } from '../resolve.js';
import {
  deleteTransaction as coreDeleteTransaction,
  resolveCategorySelection,
  updateTransaction as coreUpdateTransaction,
} from '../transaction/core.js';

/** Repo-touching precondition: true when the target bill cycle doesn't exist yet, or isn't paid. */
const assertTargetBillNotPaid = async (deps: Deps, cardId: string, period: BillPeriod): Promise<boolean> => {
  const targetBill = await deps.bills.findByCycle(cardId, period.month, period.year);
  return !targetBill || !isBillPaid(targetBill);
};

/** Repo-touching precondition: true when the transaction has no bill, or that bill isn't paid. */
const assertBillNotPaid = async (deps: Deps, billId: string | undefined): Promise<boolean> => {
  if (!billId) return true;
  const bill = await deps.bills.findById(billId);
  return !bill || !isBillPaid(bill);
};

export const addCardPurchase = (
  deps: Deps,
  input: AddCardPurchase,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategory);
    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);

    const card = yield* resolveCardRef(deps, input.card);

    const today = toIsoDate(deps.clock());
    const date = input.date ?? today;
    const status = input.status ?? defaultStatusFor(date, today);

    // Resolve the target bill period up front (explicit override or cycle-based auto-assignment) and
    // reject onto a paid bill before doing any category/merchant resolution work or writing the
    // transaction — a request that's going to be rejected shouldn't pay for that work first, and we
    // never want to leave an orphan, unattached row.
    const billPeriod: BillPeriod =
      input.billMonth !== undefined && input.billYear !== undefined
        ? billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay)
        : billPeriodFor(date, card.closingDay, card.dueDay);
    yield* guard(await assertTargetBillNotPaid(deps, card.id, billPeriod), transactionErrors.paidBillImmutable);

    const categorySelection = yield* resolveCategorySelection(deps, input, input.type);
    const classification: ClassifyOutcome = categorySelection
      ? userClassification({ id: categorySelection.categoryId, name: categorySelection.categoryName })
      : pickClassification(await deps.merchants.matchCandidates(normalizeMerchant(input.description)));
    const subCategoryId = categorySelection?.subCategoryId;

    const { transaction, created } = await deps.transactions.create(
      {
        id: deps.newId(),
        description: input.description,
        amount: input.amount,
        type: input.type,
        status,
        date,
        currency: resolveCurrency(null, card, input),
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
      },
      input.tags ?? [],
    );

    // Card transactions join their cycle's bill (fatura), created open on demand. Keyed on
    // "missing billId", not "created" — an idempotent replay of a row that was inserted but never
    // got attached (e.g. the process died between the two writes) self-heals here instead of
    // staying permanently orphaned. ensureAndAttach re-checks paid status atomically (null =
    // blocked) — closes the race where a concurrent pay_bill lands between the pre-check above and
    // this attach. On the (rare) block, only roll back by deleting the row when this call is the one
    // that inserted it (created) — never delete a pre-existing row we're merely trying to self-heal.
    let finalTransaction = transaction;
    if (!transaction.billId) {
      const attached = await deps.bills.ensureAndAttach(card.id, transaction.id, billPeriod, deps.newId());
      if (!attached && created) await deps.transactions.delete(transaction.id);
      const bill = yield* okOr(attached, transactionErrors.paidBillImmutable);
      finalTransaction = withBillId(transaction, bill.id);
    }

    const locale = await deps.locale();
    return ok({ transaction: addLocalizedLabels(finalTransaction, locale), created, classification });
  });

/**
 * Update a card transaction: validates and settles any bill reassignment (billMonth/billYear),
 * then delegates the remaining generic patch (category, description, amount, …) to the transaction
 * core — with the bill fields stripped, since this aggregate already owns and settled them.
 */
export const updateCardTransaction = (
  deps: Deps,
  input: UpdateTransaction,
  existing: TransactionView,
): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);
    yield* guardTransferMutability(existing, input);
    // A card purchase is always funded by the card's own internal liability account (ADR-010) — it
    // has no independent `account` to reassign. Reject rather than silently forwarding `account` to
    // the core patch, which would repoint `from_account_id` at an arbitrary account while leaving
    // `cardId`/`billId` untouched: the card's own account balance would stop reflecting the purchase
    // even though the bill total still counts it, and the new account would show a spurious expense.
    yield* guard(!R.isNonNullish(input.account), transactionErrors.accountChangeRejectedForCard);

    // Reassignment (billMonth/billYear given): validate up front — never leave the current or target
    // bill in a half-changed state.
    let reassignedBillId: string | undefined;
    if (input.billMonth !== undefined && input.billYear !== undefined) {
      const cardId = yield* okOr(existing.cardId, transactionErrors.billAssignmentRequiresCard);
      yield* guard(await assertBillNotPaid(deps, existing.billId), transactionErrors.paidBillImmutable);

      // A stale cardId here would be an internal FK inconsistency (deleting a card cascades to its
      // transactions), not a real user-facing case — but the error, if it ever fires, should name the
      // card that's missing, not the transaction that's present.
      const card = yield* okOr(await deps.creditCards.findById(cardId), notFound('card', cardId, []));
      const period = billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay);
      yield* guard(await assertTargetBillNotPaid(deps, card.id, period), transactionErrors.paidBillImmutable);

      // Attach before the core patch: ensureAndAttach's atomic re-check (closing the race where a
      // concurrent pay_bill lands between the pre-check above and this attach) must be able to reject
      // the request without having already written the rest of the patch — otherwise the client sees
      // an error response for a write that partially committed.
      const attached = await deps.bills.ensureAndAttach(card.id, input.id, period, deps.newId());
      const bill = yield* okOr(attached, transactionErrors.paidBillImmutable);
      reassignedBillId = bill.id;
    }

    const updated = yield* coreUpdateTransaction(deps, R.omit(input, ['billMonth', 'billYear']), existing);
    return ok(reassignedBillId ? withBillId(updated, reassignedBillId) : updated);
  });

/** Delete a card transaction: paid-bill immutability, then the core's generic delete. */
export const deleteCardTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
  existing: TransactionView,
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(await assertBillNotPaid(deps, existing.billId), transactionErrors.paidBillImmutable);
    return ok(yield* coreDeleteTransaction(deps, input, existing));
  });
