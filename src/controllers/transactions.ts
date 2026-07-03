import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { assertNonCreditType } from '../logic/account.js';
import { accountErrors } from '../models/account.js';
import { billPeriodFor, billPeriodForCycle, isBillPaid, type BillPeriod } from '../logic/bill.js';
import { notFound } from '../models/error.js';
import { pickClassification, userClassification } from '../logic/classify.js';
import { ClassificationMethod } from '../models/transaction.js';
import type { ClassifyOutcome } from '../models/transaction.js';
import { normalizeMerchant } from '../logic/merchant.js';
import { periodRange, toIsoDate } from '../logic/period.js';
import type { BulkItemResult, BulkResult } from '../logic/transaction.js';
import {
  addLocalizedLabels,
  assertBillAssignmentHasCard,
  assertBillPeriodPaired,
  assertExclusiveAccountCard,
  assertExclusiveCategorySubCategory,
  defaultStatusFor,
  deriveIdempotencyKey,
  guardTransferMutability,
  isCategoryKindAllowed,
  resolveCurrency,
  resolveEffectiveType,
  summarizeBulkItems,
  toBulkItemResult,
} from '../logic/transaction.js';
import { TransactionStatus } from '../models/transaction.js';
import {
  transactionErrors,
  type CreateTransaction,
  type CreateTransactionResult,
  type CreateTransactionsBulk,
  type DeleteTransactionResult,
  type SearchTransactions,
  type TransactionView,
  type TransactionSource,
  type UpdateTransaction,
} from '../models/transaction.js';
import type { Deps } from './deps.js';
import { resolveAccountRef, resolveCardRef, resolveCategoryRef, resolveSubCategoryRef } from './resolve.js';

export const createTransaction = (
  deps: Deps,
  input: CreateTransaction,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveAccountCard(input), transactionErrors.exclusiveAccountCard);
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategory);
    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);
    yield* guard(
      assertBillAssignmentHasCard(input.billMonth, !!input.card),
      transactionErrors.billAssignmentRequiresCard,
    );

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    if (account) {
      yield* guard(assertNonCreditType(account.type), accountErrors.creditPostRejected);
    }
    const card = input.card ? yield* resolveCardRef(deps, input.card) : null;

    let classification: ClassifyOutcome;
    let subCategoryId: string | undefined;

    if (input.subCategory) {
      const subCat = yield* resolveSubCategoryRef(deps, input.subCategory);
      yield* guard(
        isCategoryKindAllowed(input.type, subCat.kind),
        transactionErrors.categoryKindMismatch(input.type, subCat.name, subCat.kind),
      );
      subCategoryId = subCat.id;
      classification = userClassification({ id: subCat.parentId, name: subCat.parentName });
    } else if (input.category) {
      const cat = yield* resolveCategoryRef(deps, input.category);
      yield* guard(
        isCategoryKindAllowed(input.type, cat.kind),
        transactionErrors.categoryKindMismatch(input.type, cat.name, cat.kind),
      );
      classification = userClassification(cat);
    } else {
      classification = pickClassification(await deps.merchants.matchCandidates(normalizeMerchant(input.description)));
    }

    const today = toIsoDate(deps.clock());
    const date = input.date ?? today;
    const status = input.status ?? defaultStatusFor(date, today);

    // Resolve the target bill period up front (explicit override or cycle-based auto-assignment) and
    // reject onto a paid bill before writing the transaction — never leave an orphan, unattached row.
    let billPeriod: BillPeriod | null = null;
    if (card) {
      billPeriod =
        input.billMonth && input.billYear
          ? billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay)
          : billPeriodFor(date, card.closingDay, card.dueDay);
      const targetBill = await deps.bills.get(card.id, billPeriod.month, billPeriod.year);
      yield* guard(!targetBill || !isBillPaid(targetBill.bill), transactionErrors.paidBillImmutable);
    }

    const { transaction, created } = await deps.transactions.create(
      {
        id: deps.newId(),
        description: input.description,
        amount: input.amount,
        type: input.type,
        status,
        date,
        currency: resolveCurrency(account, card, input),
        source,
        idempotencyKey: input.idempotencyKey,
        classification,
        rawInput: input.rawInput,
        note: input.note,
        refs: {
          accountId: account?.id ?? card?.accountId,
          cardId: card?.id,
          categoryId: classification.categoryId,
          subCategoryId,
          merchantKey: classification.merchantKey,
        },
      },
      input.tags ?? [],
    );

    // Card transactions join their cycle's bill (fatura), created open on demand
    let finalTransaction = transaction;
    if (card && created && billPeriod) {
      const bill = await deps.bills.ensureAndAttach(card.id, transaction.id, billPeriod, deps.newId());
      finalTransaction = { ...transaction, billId: bill.id };
    }

    const locale = await deps.locale();
    return ok({ transaction: addLocalizedLabels(finalTransaction, locale), created, classification });
  });

/** Statement paste/import: each line idempotent, classified, flagged for review when uncertain. */
export const createTransactionsBulk = (
  deps: Deps,
  input: CreateTransactionsBulk,
  source: TransactionSource,
): ResultAsync<BulkResult<AppError>, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();
    const cachedDeps: Deps = { ...deps, locale: () => Promise.resolve(locale) };
    const items: BulkItemResult<AppError>[] = [];
    for (const item of input.items) {
      const date = item.date ?? toIsoDate(deps.clock());
      const result = await createTransaction(
        cachedDeps,
        {
          ...item,
          date,
          account: item.account ?? input.account,
          card: item.card ?? input.card,
          idempotencyKey: item.idempotencyKey ?? deriveIdempotencyKey({ ...item, date }),
          rawInput: input.rawInput,
        },
        source,
      );
      items.push(toBulkItemResult(result, item.description));
    }

    return ok({ summary: summarizeBulkItems(items), items });
  });

/** Repo-touching precondition: true when the transaction has no bill, or that bill isn't paid. */
const assertBillNotPaid = async (deps: Deps, billId: string | undefined): Promise<boolean> => {
  if (!billId) return true;
  const bill = await deps.bills.findById(billId);
  return !bill || !isBillPaid(bill);
};

export const updateTransaction = (deps: Deps, input: UpdateTransaction): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategoryUpdate);
    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);

    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));

    yield* guardTransferMutability(existing, input);

    // Reassignment (billMonth/billYear given): validate up front — never leave the current or target
    // bill in a half-changed state — but perform the actual attach after the main update below.
    let reassignment: { cardId: string; period: BillPeriod } | null = null;
    if (input.billMonth && input.billYear) {
      const cardId = yield* okOr(existing.cardId, transactionErrors.billAssignmentRequiresCard);
      yield* guard(await assertBillNotPaid(deps, existing.billId), transactionErrors.paidBillImmutable);

      // A stale cardId here would be an internal FK inconsistency (deleting a card cascades to its
      // transactions), not a real user-facing case — but the error, if it ever fires, should name the
      // card that's missing, not the transaction that's present.
      const card = yield* okOr(await deps.creditCards.findById(cardId), notFound('card', cardId, []));
      const period = billPeriodForCycle(input.billMonth, input.billYear, card.closingDay, card.dueDay);
      const targetBill = await deps.bills.get(card.id, period.month, period.year);
      yield* guard(!targetBill || !isBillPaid(targetBill.bill), transactionErrors.paidBillImmutable);

      reassignment = { cardId: card.id, period };
    }

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const effectiveType = resolveEffectiveType(existing, input);

    let categoryId: string | null = null;
    // undefined = leave the sub-category untouched; null = explicitly clear it.
    let subCategoryId: string | null | undefined;

    if (input.subCategory) {
      const subCat = yield* resolveSubCategoryRef(deps, input.subCategory);
      if (effectiveType)
        yield* guard(
          isCategoryKindAllowed(effectiveType, subCat.kind),
          transactionErrors.categoryKindMismatch(effectiveType, subCat.name, subCat.kind),
        );
      subCategoryId = subCat.id;
      categoryId = subCat.parentId;
    } else if (input.category) {
      const cat = yield* resolveCategoryRef(deps, input.category);
      if (effectiveType)
        yield* guard(
          isCategoryKindAllowed(effectiveType, cat.kind),
          transactionErrors.categoryKindMismatch(effectiveType, cat.name, cat.kind),
        );
      categoryId = cat.id;
      // Business rule: assigning a plain category clears any prior sub-category —
      // "sub-category always paired with its parent" would otherwise go stale.
      subCategoryId = null;
    }

    const isUserCorrection = !!(input.category || input.subCategory);

    const updated = yield* okOr(
      await deps.transactions.update(
        input.id,
        {
          description: input.description,
          amount: input.amount,
          type: input.type,
          date: input.date,
          currency: account?.currency,
          classification: isUserCorrection ? { method: ClassificationMethod.enum.user, confidence: 1 } : undefined,
          note: input.note,
        },
        { accountId: account?.id ?? null, categoryId, subCategoryId, tagNames: input.tags ?? null },
      ),
      transactionErrors.notFound(input.id),
    );

    // Learning loop: correcting the category strengthens the merchant→category association
    if (categoryId && categoryId !== existing.categoryId)
      await deps.merchants.strengthenFromTransaction(input.id, categoryId);

    // Reassign after the main update succeeds — a later validation failure above must never leave
    // the bill assignment changed while the rest of the patch was rejected.
    let finalTransaction = updated;
    if (reassignment) {
      const bill = await deps.bills.ensureAndAttach(reassignment.cardId, updated.id, reassignment.period, deps.newId());
      finalTransaction = { ...updated, billId: bill.id };
    }

    const locale = await deps.locale();
    return ok(addLocalizedLabels(finalTransaction, locale));
  });

/** Flip a pending transaction to effective. No-op (returns existing) if already effective. */
export const confirmTransaction = (deps: Deps, input: { id: string }): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));

    const locale = await deps.locale();

    if (existing.status === TransactionStatus.enum.effective) return ok(addLocalizedLabels(existing, locale));

    const confirmed = yield* okOr(await deps.transactions.confirm(input.id), transactionErrors.notFound(input.id));
    return ok(addLocalizedLabels(confirmed, locale));
  });

export const deleteTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));

    yield* guard(await assertBillNotPaid(deps, existing.billId), transactionErrors.paidBillImmutable);

    const locale = await deps.locale();
    const labeled = addLocalizedLabels(existing, locale);

    if (!input.confirm)
      return ok({
        deleted: false as const,
        dryRun: true as const,
        wouldDelete: labeled,
        hint: 'Destructive action: show the transaction to the user and call again with confirm: true.',
      });

    await deps.transactions.delete(input.id);
    return ok({ deleted: true as const, transaction: labeled });
  });

export const searchTransactions = (deps: Deps, input: SearchTransactions): ResultAsync<TransactionView[], AppError> =>
  safeTry(async function* () {
    const range = input.month && input.year ? periodRange({ month: input.month, year: input.year }) : null;
    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    const category = input.category ? yield* resolveCategoryRef(deps, input.category) : null;
    const subCategory = input.subCategory ? yield* resolveSubCategoryRef(deps, input.subCategory) : null;

    const [locale, rows] = await Promise.all([
      deps.locale(),
      deps.transactions.search({
        from: range?.from ?? input.from ?? null,
        to: range?.to ?? input.to ?? null,
        type: input.type ?? null,
        status: input.status ?? null,
        text: input.text ?? null,
        accountId: account?.id ?? null,
        categoryId: category?.id ?? null,
        subCategoryId: subCategory?.id ?? null,
        tagNames: input.tags ?? [],
        limit: input.limit,
      }),
    ]);
    return ok(rows.map(addLocalizedLabels(locale)));
  });
