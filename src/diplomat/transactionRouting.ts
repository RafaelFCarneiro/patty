// Composition-root routing (ADR-016 step 4, ADR-017): decides, for a create_transactions_bulk line,
// whether the credit-card aggregate or the account aggregate owns it, and dispatches accordingly.
// Shared by diplomat/mcp and diplomat/http so both surfaces route identically. This is delegation,
// not domain logic — the actual bill/card policy lives in controllers/creditCard/*, and
// account-movement policy in controllers/account/*.
//
// The god create_transaction tool/route (which used to expose this account-vs-card dispatch
// directly) is retired (ADR-016 step 4), and update/delete's former routers are retired too
// (ADR-017 step 1: update_card_transaction/delete_card_transaction and
// update_account_transaction/delete_account_transaction now self-validate ownership instead of
// being dispatched to). The per-line dispatch decision below survives only as a private helper for
// create_transactions_bulk — a statement paste/CSV import still needs to route each line to its
// owning aggregate by presence of `account` vs `card` (ADR-017 step 2 retires this too).

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../common/errors.js';
import { guard } from '../common/result.js';
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
  type TransactionSource,
} from '../models/transaction.js';
import { addAccountExpense, addAccountIncome } from '../controllers/account/transaction.js';
import { addCardPurchase } from '../controllers/creditCard/transaction.js';
import type { Deps } from '../controllers/deps.js';
import { createTransactionsBulk } from '../controllers/transaction/bulk.js';

/** Per-line dispatch used only by create_transactions_bulk (not exposed as its own MCP tool/REST
 *  route — see module header). Same exclusivity/bill-assignment guards the retired create_transaction
 *  used to apply before dispatching to the owning aggregate. */
const routeTransactionLine = (
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
): ResultAsync<BulkResult<AppError>, AppError> => createTransactionsBulk(deps, input, source, routeTransactionLine);
