import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import type { CreateCreditCard, CreditCard } from '../models/creditCard.js'
import type { Deps } from './deps.js'

export const listCreditCards = (deps: Deps): Promise<CreditCard[]> => deps.creditCards.list()

export const createCreditCard = async (
  deps: Deps,
  input: CreateCreditCard,
): Promise<Result<CreditCard, AppError>> => {
  const existing = await deps.creditCards.findByName(input.name)
  if (existing) return err({ code: 'duplicate_name', entity: 'credit_card', name: input.name })
  const card = await deps.creditCards.create({ id: deps.newId(), ...input })
  return ok(card)
}
