import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { resolveByName } from '../logic/resolve.js'
import type { Bill } from '../models/bill.js'
import type { BillWithItems } from '../diplomat/db/repos/bills.js'
import type { Deps } from './deps.js'

const resolveCard = async (deps: Deps, name: string) => {
  const res = resolveByName(await deps.creditCards.list(), name)
  if (res.kind === 'none')
    return err<never, AppError>({ code: 'unknown_card', query: res.query, candidates: res.candidates })
  if (res.kind === 'ambiguous')
    return err<never, AppError>({ code: 'ambiguous_card', query: res.query, candidates: res.candidates })
  return ok(res.entity)
}

export const getBill = async (
  deps: Deps,
  input: { card: string; month: number; year: number },
): Promise<Result<BillWithItems, AppError>> => {
  const card = await resolveCard(deps, input.card)
  if (card.isErr()) return err(card.error)
  const bill = await deps.bills.get(card.value.id, input.month, input.year)
  if (!bill) return err({ code: 'unknown_bill', card: card.value.name, month: input.month, year: input.year })
  return ok(bill)
}

/**
 * Marks the bill paid. Deliberately does NOT create a payment transaction:
 * the card's transactions already count as expenses — a payment expense would double-count.
 * (Account balance tracking will model this as a transfer in a later phase.)
 */
export const payBill = async (
  deps: Deps,
  input: { card: string; month: number; year: number },
): Promise<Result<Bill, AppError>> => {
  const card = await resolveCard(deps, input.card)
  if (card.isErr()) return err(card.error)
  const bill = await deps.bills.get(card.value.id, input.month, input.year)
  if (!bill) return err({ code: 'unknown_bill', card: card.value.name, month: input.month, year: input.year })
  const updated = await deps.bills.setStatus(bill.bill.id, 'paid')
  return ok(updated!)
}
