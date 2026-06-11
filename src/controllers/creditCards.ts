import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import type { CreateCreditCard, CreditCard } from '../models/creditCard.js'
import type { Deps } from './deps.js'

export const listCreditCards = (deps: Deps): Promise<CreditCard[]> => deps.creditCards.list()

export const createCreditCard = (
  deps: Deps,
  input: CreateCreditCard,
): ResultAsync<CreditCard, AppError> =>
  safeTry(async function* () {
    yield* guard(!(await deps.creditCards.findByName(input.name)), {
      code: 'duplicate_name',
      entity: 'credit_card',
      name: input.name,
    })
    return ok(await deps.creditCards.create({ id: deps.newId(), ...input }))
  })
