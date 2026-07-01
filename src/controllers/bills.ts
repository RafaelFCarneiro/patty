import { ok, safeTry, type ResultAsync } from 'neverthrow';
import type { AppError } from '../common/errors.js';
import { guard, okOr } from '../common/result.js';
import { assertCurrencyMatch, assertNonCreditType } from '../logic/account.js';
import { computeBillTotal, withStatusLabel } from '../logic/bill.js';
import { toIsoDate } from '../logic/period.js';
import { addLocalizedLabels, defaultStatusFor } from '../logic/transaction.js';
import { accountErrors } from '../models/account.js';
import { billErrors, BillStatus, type Bill, type BillQuery, type PayBill } from '../models/bill.js';
import {
  ClassificationMethod,
  type TransactionSource as TransactionSourceType,
  TransactionType,
} from '../models/transaction.js';
import type { BillWithItems } from '../diplomat/db/repos/bills.js';
import type { Deps } from './deps.js';
import { resolveAccountRef, resolveCardRef } from './resolve.js';

export type BillView = BillWithItems & { total: number };

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

export const payBill = (deps: Deps, input: PayBillInput): ResultAsync<Bill, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card);
    const existing = yield* okOr(
      await deps.bills.get(card.id, input.month, input.year),
      billErrors.notFound(card.name, input.month, input.year),
    );

    if (existing.bill.status === BillStatus.enum.paid) return ok(existing.bill);

    const total = computeBillTotal(existing.transactions);

    if (total <= 0) {
      const paid = yield* okOr(
        await deps.bills.setStatus(existing.bill.id, BillStatus.enum.paid),
        billErrors.notFound(card.name, input.month, input.year),
      );
      return ok(paid);
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

    await deps.transactions.create(
      {
        id: deps.newId(),
        description: `Bill payment: ${card.name} ${String(input.month).padStart(2, '0')}/${input.year}`,
        amount: total,
        type: TransactionType.enum.transfer,
        status: defaultStatusFor(today, today),
        date: today,
        currency: card.currency,
        source: input.source,
        idempotencyKey: `billpay-${existing.bill.id}`,
        classification: { method: ClassificationMethod.enum.none, confidence: 0 },
        refs: { accountId: payer.id, toAccountId: card.accountId, billId: existing.bill.id },
      },
      [],
    );

    const paid = yield* okOr(
      await deps.bills.setStatus(existing.bill.id, BillStatus.enum.paid),
      billErrors.notFound(card.name, input.month, input.year),
    );
    return ok(paid);
  });
