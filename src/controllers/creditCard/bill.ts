import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../../common/errors.js';
import { guard, okOr } from '../../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../../logic/account.js';
import { billEntityFrom, computeBillTotal, toBillView, withStatusLabel } from '../../logic/bill.js';
import * as persistence from '../../logic/persistence.js';
import { toIsoDate } from '../../logic/period.js';
import { addLocalizedLabels, defaultStatusFor } from '../../logic/transaction.js';
import { accountErrors } from '../../models/account.js';
import {
  billErrors,
  BILL_ENTITY_TAG,
  BillStatus,
  type Bill,
  type BillQuery,
  type BillView,
  type PayBill,
  type RawBill,
} from '../../models/bill.js';
import type { FlowOutcome, Persistable } from '../../models/persistable.js';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  type TransactionEntity,
  type TransactionSource as TransactionSourceType,
  TransactionType,
} from '../../models/transaction.js';
import type { Deps } from '../deps.js';
import { resolveAccountRef, resolveCardRef } from '../resolve.js';

export const getBill = (deps: Deps, input: BillQuery): ResultAsync<BillView, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const bill = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );
    const locale = await deps.locale();
    return ok({
      ...bill,
      bill: withStatusLabel(bill.bill, locale),
      transactions: bill.transactions.map(addLocalizedLabels(locale)),
      total: computeBillTotal(bill.transactions),
    });
  });

export type PayBillInput = PayBill & { source: TransactionSourceType };

/** Builds the version-guarded bill `update` that marks a bill paid, plus the response the caller
 *  sees — shared by the zero-total (no transfer) and positive-total (with transfer) branches of
 *  `payBill` below. `paymentTransactionId` absent (`undefined`) for the zero-total case — the bill
 *  was never paid before, so the column was already unset; present for the positive-total case. */
const buildPaidBillWrite = (
  rawBill: RawBill,
  paymentTransactionId?: string,
): { persistable: Persistable; response: Bill } => {
  const status = BillStatus.enum.paid;
  return {
    persistable: persistence.update({
      entity: BILL_ENTITY_TAG,
      model: { ...billEntityFrom(rawBill), status, paymentTransactionId },
    }),
    response: { ...toBillView(rawBill), status, paymentTransactionId },
  };
};

/**
 * Pay a credit card bill (ADR-021 phase 2c): reads the bill and its transactions, and — unless
 * already paid (idempotent) — returns the write as data instead of performing it. A positive total
 * emits an atomic batch of [payment-transfer insert, version-guarded bill update]; the transfer's
 * `billpay-<billId>` idempotency key makes the insert replay-safe, and the bill's `version` guard
 * makes a concurrent pay/edit land as a conflict → the shell rolls back, re-invokes this flow for a
 * fresh read, and finds the bill already paid — idempotent on the retry. A non-positive total marks
 * the bill paid with no transfer at all.
 */
export const payBill = (deps: Deps, input: PayBillInput): ResultAsync<FlowOutcome<Bill>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const existing = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (existing.bill.status === BillStatus.enum.paid) {
      return ok({ persist: [], response: existing.bill });
    }

    const total = computeBillTotal(existing.transactions);
    const rawBill = yield* okOr(
      await deps.bills.findById(existing.bill.id),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (total <= 0) {
      const { persistable, response } = buildPaidBillWrite(rawBill);
      return ok({ persist: [persistable], response });
    }

    // Resolve the paying account: explicit > card default > error
    const payer = input.account
      ? yield* resolveAccountRef(deps, input.account)
      : yield* okOr(
          card.paymentAccountId ? await deps.accounts.findById(card.paymentAccountId) : null,
          billErrors.noPayingAccount,
        );

    yield* guard(assertNonCreditType(payer.type), accountErrors.creditPaymentRejected);
    yield* guard(assertCurrencyMatch(payer, card), accountErrors.currencyMismatch(card.currency, payer.currency));

    const today = toIsoDate(deps.clock());
    const txId = deps.newId();
    const transferEntity: TransactionEntity = {
      id: txId,
      description: `Bill payment: ${card.name} ${String(input.month).padStart(2, '0')}/${input.year}`,
      amount: total,
      type: TransactionType.enum.transfer,
      status: defaultStatusFor(today, today),
      date: today,
      currency: card.currency,
      source: input.source,
      idempotencyKey: `billpay-${rawBill.id}`,
      classification: { method: ClassificationMethod.enum.none, confidence: 0 },
      refs: { accountId: payer.id, toAccountId: card.accountId, billId: rawBill.id },
      tagNames: [],
    };

    // The transfer must be inserted before the bill update that references its (freshly minted)
    // id via paymentTransactionId — the FK would otherwise point at a row that doesn't exist yet.
    const { persistable: billUpdate, response } = buildPaidBillWrite(rawBill, txId);
    const persist: Persistable[] = [
      persistence.insert({ entity: TRANSACTION_ENTITY_TAG, model: transferEntity }),
      billUpdate,
    ];
    return ok({ persist, response });
  });

/** Builds the version-guarded bill `update` that flips a paid bill back to closed and clears its
 *  payment-transaction link — `null` (not `undefined`) so the write actually clears the column
 *  (`BillEntity`'s doc comment; drizzle's `.set()` drops `undefined`-valued keys). */
const buildClosedBillWrite = (rawBill: RawBill): { persistable: Persistable; response: Bill } => ({
  persistable: persistence.update({
    entity: BILL_ENTITY_TAG,
    model: { ...billEntityFrom(rawBill), status: BillStatus.enum.closed, paymentTransactionId: null },
  }),
  response: { ...toBillView(rawBill), status: BillStatus.enum.closed, paymentTransactionId: undefined },
});

/**
 * Undo a bill payment (ADR-021 phase 2c): deletes its payment transfer and flips paid → closed,
 * returned as data instead of performed. Not-paid bills are a no-op (idempotent, mirrors payBill's
 * own idempotency). When a payment transfer exists, the bill update is version-guarded and ordered
 * *before* the transfer removal in the batch — the reverse of payBill's own insert-before-update
 * order, but for the same FK reason: `bills.payment_transaction_id` references `transactions.id`
 * with no cascading action, and libsql enforces foreign keys, so the bill's own reference must be
 * cleared before the row it points to can be deleted (mirrors the pre-ADR-021 `revertPayment` repo
 * method's own "FK-safe order" comment).
 */
export const revertBillPayment = (deps: Deps, input: BillQuery): ResultAsync<FlowOutcome<Bill>, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const existing = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (existing.bill.status !== BillStatus.enum.paid) {
      return ok({ persist: [], response: existing.bill });
    }

    const rawBill = yield* okOr(
      await deps.bills.findById(existing.bill.id),
      billErrors.notFound(card.name, input.month, input.year),
    );
    const { persistable: billUpdate, response } = buildClosedBillWrite(rawBill);

    if (!rawBill.paymentTransactionId) {
      return ok({ persist: [billUpdate], response });
    }

    const paymentTx = await deps.transactions.getById(rawBill.paymentTransactionId);
    // A paid bill's paymentTransactionId always points at a real, exclusively-owned transfer
    // (pay_bill's own row — never editable/deletable by any other flow); a miss here would be data
    // corruption, not an expected outcome, so this throws rather than joining the AppError track.
    if (!paymentTx) {
      throw new Error(
        `revertBillPayment: dangling paymentTransactionId ${rawBill.paymentTransactionId} on bill ${rawBill.id}`,
      );
    }

    const persist: Persistable[] = [
      billUpdate,
      persistence.remove({ entity: TRANSACTION_ENTITY_TAG, id: paymentTx.id, version: paymentTx.version }),
    ];
    return ok({ persist, response });
  });
