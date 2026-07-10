// Transaction core (ADR-016): bulk import routing. No bill/card knowledge — must never import
// logic/bill.js or touch deps.bills. createTransactionsBulk receives the credit-card aggregate's
// and account aggregate's movement primitives as injected callbacks from the diplomat composition
// root (src/diplomat/transactionRouting.ts) instead of importing those aggregates directly, so the
// one-way dependency (aggregate → core, never the reverse) holds even while bulk import still
// routes each line to its owner from inside this module.

import { ok, safeTry, type ResultAsync } from 'neverthrow';
import * as R from 'remeda';
import type { AppError } from '../../common/errors.js';
import { guard } from '../../common/result.js';
import { toIsoDate } from '../../logic/period.js';
import type { BulkItemResult, BulkResult } from '../../logic/transaction.js';
import {
  assertBillAssignmentHasCard,
  assertBillPeriodPaired,
  assertExclusiveAccountCard,
  deriveIdempotencyKey,
  summarizeBulkItems,
  toBulkItemResult,
} from '../../logic/transaction.js';
import {
  transactionErrors,
  MovementType,
  type BulkTransactionItem,
  type CreateTransaction,
  type CreateTransactionResult,
  type CreateTransactionsBulk,
  type TransactionSource,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';

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

/**
 * The account aggregate's expense/income entry points, injected by the diplomat composition root —
 * same structural-typing reasoning as `AddCardPurchaseFn` above, against `models/account.ts`'s
 * `AddAccountMovement`.
 */
export type AddAccountMovementFn = (
  deps: Deps,
  input: Omit<CreateTransaction, 'card' | 'type' | 'billMonth' | 'billYear'>,
  source: TransactionSource,
) => ResultAsync<CreateTransactionResult, AppError>;

/** One resolved bulk line, ready to route: item fields already defaulted (date, account/card
 *  top-level fallback, idempotencyKey). */
type BulkLine = BulkTransactionItem & { date: string; idempotencyKey: string };

/** Routes a single resolved bulk line to its owning aggregate — same exclusivity/pairing guards
 *  `create_transaction` itself enforces, since a line can resolve both `account` and `card` via
 *  top-level defaults. */
const routeBulkLine = (
  deps: Deps,
  line: BulkLine,
  rawInput: string | undefined,
  source: TransactionSource,
  addCardPurchase: AddCardPurchaseFn,
  addAccountExpense: AddAccountMovementFn,
  addAccountIncome: AddAccountMovementFn,
): ResultAsync<CreateTransactionResult, AppError> =>
  safeTry(async function* () {
    yield* guard(assertExclusiveAccountCard(line), transactionErrors.exclusiveAccountCard);

    if (R.isNonNullish(line.card)) {
      return ok(yield* addCardPurchase(deps, { ...R.omit(line, ['account']), card: line.card, rawInput }, source));
    }

    yield* guard(assertBillPeriodPaired(line), transactionErrors.billPeriodIncomplete);
    yield* guard(assertBillAssignmentHasCard(line.billMonth, false), transactionErrors.billAssignmentRequiresCard);

    const addAccountMovement = line.type === MovementType.enum.expense ? addAccountExpense : addAccountIncome;
    return ok(
      yield* addAccountMovement(deps, { ...R.omit(line, ['card', 'type', 'billMonth', 'billYear']), rawInput }, source),
    );
  });

/** Statement paste/import: each line idempotent, classified, flagged for review when uncertain.
 *  Routes card lines to the credit-card aggregate (`addCardPurchase`, injected), account lines to
 *  the account aggregate (`addAccountExpense`/`addAccountIncome`, injected, chosen by the line's
 *  `type`). */
export const createTransactionsBulk = (
  deps: Deps,
  input: CreateTransactionsBulk,
  source: TransactionSource,
  addCardPurchase: AddCardPurchaseFn,
  addAccountExpense: AddAccountMovementFn,
  addAccountIncome: AddAccountMovementFn,
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
      const line: BulkLine = { ...item, date, account, card, idempotencyKey };

      const result = await routeBulkLine(
        cachedDeps,
        line,
        input.rawInput,
        source,
        addCardPurchase,
        addAccountExpense,
        addAccountIncome,
      );

      items.push(toBulkItemResult(result, item.description));
    }

    return ok({ summary: summarizeBulkItems(items), items });
  });
