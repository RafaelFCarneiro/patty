import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard, okOr } from '../common/result.js'
import { BillStatus, type Bill } from '../models/bill.js'
import { AccountType } from '../models/account.js'
import { ClassificationMethod, TransactionSource, TransactionStatus, TransactionType } from '../models/transaction.js'
import type { BillWithItems } from '../diplomat/db/repos/bills.js'
import { computeBillTotal } from '../logic/bill.js'
import { toIsoDate } from '../logic/period.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCardRef } from './resolve.js'

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
    return ok({ ...bill, total: computeBillTotal(bill.transactions) })
  })

export type PayBillInput = { card: string; month: number; year: number; account?: string }

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
    const payerAccountId = input.account
      ? (yield* resolveAccountRef(deps, input.account)).id
      : card.paymentAccountId

    yield* guard(!!payerAccountId, {
      code: 'validation',
      issues: ['no paying account: pass `account` or set the card\'s payment account'],
    })

    const payer = yield* okOr(await deps.accounts.findById(payerAccountId!), {
      code: 'validation',
      issues: ['payment account not found'],
    })

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
      status: TransactionStatus.enum.effective,
      date: today,
      currency: card.currency,
      source: TransactionSource.enum.mcp,
      idempotencyKey: `billpay-${existing.bill.id}`,
      classification: { method: ClassificationMethod.enum.none, confidence: 0 },
      refs: { accountId: payer.id, toAccountId: card.accountId },
    }, [])

    const paid = yield* okOr(await deps.bills.setStatus(existing.bill.id, BillStatus.enum.paid), {
      code: 'unknown_bill',
      card: card.name,
      month: input.month,
      year: input.year,
    })
    return ok(paid)
  })
