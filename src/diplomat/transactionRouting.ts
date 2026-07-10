// Composition-root routing (ADR-016 steps 2-3): decides, for a transaction id or a create request,
// whether the credit-card aggregate, the account aggregate, or the transaction core owns it, and
// dispatches accordingly. Shared by diplomat/mcp and diplomat/http so both surfaces route
// identically. This is delegation, not domain logic — the actual bill/card policy lives in
// controllers/creditCard/*, and account-movement policy in controllers/account/*.

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import {
  assertBillAssignmentHasCard,
  assertBillPeriodPaired,
  assertExclusiveAccountCard,
  hasCard,
} from '../logic/transaction.js';
import type { BulkResult } from '../logic/transaction.js';
import {
  transactionErrors,
  MovementType,
  type CreateTransaction,
  type CreateTransactionResult,
  type CreateTransactionsBulk,
  type DeleteTransactionResult,
  type TransactionSource,
  type TransactionView,
  type UpdateTransaction,
} from '../models/transaction.js';
import { addAccountExpense, addAccountIncome } from '../controllers/account/transaction.js';
import {
  addCardPurchase,
  deleteCardTransaction,
  updateCardTransaction,
} from '../controllers/creditCard/transaction.js';
import type { Deps } from '../controllers/deps.js';
import { createTransactionsBulk } from '../controllers/transaction/bulk.js';
import {
  deleteTransaction as coreDeleteTransaction,
  updateTransaction as coreUpdateTransaction,
} from '../controllers/transaction/core.js';

export const routeCreateTransaction = (
  deps: Deps,
  input: CreateTransaction,
  source: TransactionSource,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveAccountCard(input), transactionErrors.exclusiveAccountCard);

    if (hasCard(input)) {
      return ok(yield* addCardPurchase(deps, { ...R.omit(input, ['account']), card: input.card }, source));
    }

    yield* guard(assertBillPeriodPaired(input), transactionErrors.billPeriodIncomplete);
    yield* guard(assertBillAssignmentHasCard(input.billMonth, false), transactionErrors.billAssignmentRequiresCard);
    const accountMovement = R.omit(input, ['card', 'type', 'billMonth', 'billYear']);
    return ok(
      yield* input.type === MovementType.enum.expense
        ? addAccountExpense(deps, accountMovement, source)
        : addAccountIncome(deps, accountMovement, source),
    );
  });

export const routeCreateTransactionsBulk = (
  deps: Deps,
  input: CreateTransactionsBulk,
  source: TransactionSource,
): ResultAsync<BulkResult<AppError>, AppError> => createTransactionsBulk(deps, input, source, routeCreateTransaction);

export const routeUpdateTransaction = (deps: Deps, input: UpdateTransaction): ResultAsync<TransactionView, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    // Keyed on cardId, not billId (contrast routeDeleteTransaction): only a card-owned transaction
    // can ever be reassigned to a different bill cycle, and a card purchase that hasn't attached to
    // a bill yet (cardId set, billId still absent — the self-heal window) must still be able to
    // reach the aggregate's reassignment/attach path.
    return ok(
      existing.cardId
        ? yield* updateCardTransaction(deps, input, existing)
        : yield* coreUpdateTransaction(deps, input, existing),
    );
  });

export const routeDeleteTransaction = (
  deps: Deps,
  input: { id: string; confirm: boolean },
): ResultAsync<DeleteTransactionResult, AppError> =>
  safeTry(async function* () {
    const existing = yield* okOr(await deps.transactions.getById(input.id), transactionErrors.notFound(input.id));
    // Keyed on billId, not cardId: a bill payment transfer carries a billId (the bill it paid) but
    // no cardId (it's a transfer between accounts, not a card purchase) — it still needs the
    // paid-bill immutability guard, so it must route to the aggregate too.
    return ok(
      existing.billId
        ? yield* deleteCardTransaction(deps, input, existing)
        : yield* coreDeleteTransaction(deps, input, existing),
    );
  });
