// Transaction movement (ADR-016 step 2): account-only creation + bulk import routing. No bill/card
// knowledge — must never import logic/bill.js or touch deps.bills. createTransactionsBulk receives
// a card-purchase primitive as an injected callback from the diplomat composition root
// (src/diplomat/transactionRouting.ts) instead of importing the credit-card aggregate directly, so
// the one-way dependency (aggregate → core, never the reverse) holds even while bulk import still
// routes each line to its owner from inside this module.

import { err, ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard } from '../../common/result.js';
import { assertNonCreditType } from '../../logic/account.js';
import { pickClassification, userClassification } from '../../logic/classify.js';
import { normalizeMerchant } from '../../logic/merchant.js';
import { toIsoDate } from '../../logic/period.js';
import type { BulkItemResult, BulkResult } from '../../logic/transaction.js';
import {
  addLocalizedLabels,
  assertBillAssignmentHasCard,
  assertBillPeriodPaired,
  assertExclusiveAccountCard,
  assertExclusiveCategorySubCategory,
  defaultStatusFor,
  deriveIdempotencyKey,
  resolveCurrency,
  summarizeBulkItems,
  toBulkItemResult,
} from '../../logic/transaction.js';
import { accountErrors } from '../../models/account.js';
import {
  transactionErrors,
  type ClassifyOutcome,
  type CreateTransaction,
  type CreateTransactionResult,
  type CreateTransactionsBulk,
  type TransactionSource,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef } from '../resolve.js';
import { resolveCategorySelection } from './core.js';

/**
 * The credit-card aggregate's card-purchase entry point, injected by the diplomat composition root
 * rather than imported directly — see module header. Typed structurally against the core's own
 * `CreateTransaction` (not by importing `models/creditCard.ts`'s `AddCardPurchase`): the transaction
 * core must not reference the credit-card domain's model any more than its controllers, even for a
 * type-only import — the real `addCardPurchase` (whose parameter is the nominal `AddCardPurchase`
 * type) is structurally identical and satisfies this signature.
 */
export type AddCardPurchaseFn = (
  deps: Deps,
  input: Omit<CreateTransaction, 'account'> & { card: string },
  source: TransactionSource,
) => ResultAsync<CreateTransactionResult, AppError>;

export const createTransaction = (
  deps: Deps,
  input: CreateTransaction,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveCategorySubCategory(input), transactionErrors.exclusiveCategorySubCategory);
    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);
    yield* guard(assertBillAssignmentHasCard(input.billMonth, false), transactionErrors.billAssignmentRequiresCard);

    const account = input.account ? yield* resolveAccountRef(deps, input.account) : null;
    if (account) {
      yield* guard(assertNonCreditType(account.type), accountErrors.creditPostRejected);
    }

    const today = toIsoDate(deps.clock());
    const date = input.date ?? today;
    const status = input.status ?? defaultStatusFor(date, today);

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

/** Statement paste/import: each line idempotent, classified, flagged for review when uncertain.
 *  Routes card lines to the credit-card aggregate (`addCardPurchase`, injected), account lines to
 *  `createTransaction` above — mirroring the exclusivity/pairing guards `create_transaction` itself
 *  enforces, since a bulk item can resolve both `account` and `card` via top-level defaults. */
export const createTransactionsBulk = (
  deps: Deps,
  input: CreateTransactionsBulk,
  source: TransactionSource,
  addCardPurchase: AddCardPurchaseFn,
): ResultAsync<BulkResult<AppError>, AppError> =>
  safeTry(async function* () {
    const locale = await deps.locale();
    const cachedDeps: Deps = { ...deps, locale: () => Promise.resolve(locale) };
    const items: BulkItemResult<AppError>[] = [];
    for (const item of input.items) {
      const date = item.date ?? toIsoDate(deps.clock());
      const account = item.account ?? input.account;
      const card = item.card ?? input.card;
      const idempotencyKey = item.idempotencyKey ?? deriveIdempotencyKey({ ...item, date });

      const result = !assertExclusiveAccountCard({ account, card })
        ? err(transactionErrors.exclusiveAccountCard)
        : card
          ? await addCardPurchase(
              cachedDeps,
              { ...R.omit(item, ['account']), date, card, idempotencyKey, rawInput: input.rawInput },
              source,
            )
          : await createTransaction(
              cachedDeps,
              { ...item, date, account, idempotencyKey, rawInput: input.rawInput },
              source,
            );

      items.push(toBulkItemResult(result, item.description));
    }

    return ok({ summary: summarizeBulkItems(items), items });
  });
