import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { okOr } from '../common/result.js'
import type { Bill } from '../models/bill.js'
import type { BillWithItems } from '../diplomat/db/repos/bills.js'
import { computeBillTotal } from '../logic/bill.js'
import type { Deps } from './deps.js'
import { resolveCardRef } from './resolve.js'

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

/**
 * Marks the bill paid. Deliberately does NOT create a payment transaction:
 * the card's transactions already count as expenses — a payment expense would double-count.
 * (Account balance tracking will model this as a transfer in a later phase.)
 */
export const payBill = (
  deps: Deps,
  input: { card: string; month: number; year: number },
): ResultAsync<Bill, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card)
    const existing = yield* okOr(await deps.bills.get(card.id, input.month, input.year), {
      code: 'unknown_bill',
      card: card.name,
      month: input.month,
      year: input.year,
    })
    const paid = yield* okOr(await deps.bills.setStatus(existing.bill.id, 'paid'), {
      code: 'unknown_bill',
      card: card.name,
      month: input.month,
      year: input.year,
    })
    return ok(paid)
  })
