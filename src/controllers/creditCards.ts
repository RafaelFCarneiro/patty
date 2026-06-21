import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { AccountType } from '../models/account.js'
import type { CreateCreditCard, CreditCard } from '../models/creditCard.js'
import type { Deps } from './deps.js'
import { resolveAccountRef } from './resolve.js'

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

    let paymentAccountId: string | undefined
    if (input.paymentAccount) {
      const paymentAccount = yield* resolveAccountRef(deps, input.paymentAccount)
      yield* guard(paymentAccount.type !== AccountType.enum.credit, {
        code: 'validation',
        issues: ['payment account cannot be a credit account'],
      })
      yield* guard(paymentAccount.currency === input.currency, {
        code: 'validation',
        issues: [`currency mismatch: card is ${input.currency}, payment account is ${paymentAccount.currency}`],
      })
      paymentAccountId = paymentAccount.id
    }

    const internalAccountName = `Card: ${input.name}`
    yield* guard(!(await deps.accounts.findByName(internalAccountName)), {
      code: 'duplicate_name',
      entity: 'account',
      name: internalAccountName,
    })

    const accountId = deps.newId()
    const internalAccount = {
      id: accountId,
      name: internalAccountName,
      type: AccountType.enum.credit,
      currency: input.currency,
      initialBalance: 0,
    }

    return ok(await deps.creditCards.createWithAccount(
      {
        id: deps.newId(),
        name: input.name,
        currency: input.currency,
        closingDay: input.closingDay,
        dueDay: input.dueDay,
        limit: input.limit,
        accountId,
        paymentAccountId,
      },
      internalAccount,
    ))
  })
