import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard, okOr } from '../common/result.js'
import { BillStatus, type Bill } from '../models/bill.js'
import { AccountType } from '../models/account.js'
import { ClassificationMethod, type TransactionSource as TransactionSourceType, TransactionType } from '../models/transaction.js'
import type { BillWithItems } from '../diplomat/db/repos/bills.js'
import { computeBillTotal } from '../logic/bill.js'
import { localizeBillStatus } from '../logic/labels.js'
import { toIsoDate } from '../logic/period.js'
import { defaultStatusFor } from '../logic/transaction.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCardRef } from './resolve.js'
import { withTransactionLabels } from './transactions.js'

export type BillView = BillWithItems & { total: number }

export const getBill = (
  deps: Deps,
  input: { card: string; month: number; year: number },
): ResultAsync<BillView, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card)
    const bill = yield* okOr(await deps.bills.get(card.id, input.month, input.year), {
      code: 'unknown_bill',
      card: card.name,
      month: input.month,
      year: input.year,
    })
    const locale = await deps.locale()
    return ok({
      ...bill,
      bill: { ...bill.bill, statusLabel: localizeBillStatus(bill.bill.status, locale) },
      transactions: bill.transactions.map((tx) => withTransactionLabels(tx, locale)),
      total: computeBillTotal(bill.transactions),
    })
  })

export type PayBillInput = { card: string; month: number; year: number; account?: string; source: TransactionSourceType }

export const payBill = (
  deps: Deps,
  input: PayBillInput,
): ResultAsync<Bill, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card)
    const existing = yield* okOr(await deps.bills.get(card.id, input.month, input.year), {
      code: 'unknown_bill',
      card: card.name,
      month: input.month,
      year: input.year,
    })

    if (existing.bill.status === BillStatus.enum.paid) return ok(existing.bill)

    const total = computeBillTotal(existing.transactions)

    if (total <= 0) {
      const paid = yield* okOr(await deps.bills.setStatus(existing.bill.id, BillStatus.enum.paid), {
        code: 'unknown_bill',
        card: card.name,
        month: input.month,
        year: input.year,
      })
      return ok(paid)
    }

    // Resolve the paying account: explicit > card default > error
    const payer = input.account
      ? yield* resolveAccountRef(deps, input.account)
      : yield* okOr(
          card.paymentAccountId ? await deps.accounts.findById(card.paymentAccountId) : null,
          { code: 'validation', issues: ['no paying account: pass `account` or set `paymentAccount` on the card'] },
        )

    yield* guard(payer.type !== AccountType.enum.credit, {
      code: 'validation',
      issues: ['payment account cannot be a credit account'],
    })
    yield* guard(payer.currency === card.currency, {
      code: 'validation',
      issues: [`currency mismatch: card is ${card.currency}, payer is ${payer.currency}`],
    })

    const today = toIsoDate(deps.clock())

    await deps.transactions.create({
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
    }, [])

    const paid = yield* okOr(await deps.bills.setStatus(existing.bill.id, BillStatus.enum.paid), {
      code: 'unknown_bill',
      card: card.name,
      month: input.month,
      year: input.year,
    })
    return ok(paid)
  })
