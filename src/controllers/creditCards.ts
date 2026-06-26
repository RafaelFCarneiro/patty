import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { accountErrors, AccountType } from '../models/account.js'
import { validation } from '../models/error.js'
import { cardErrors, type CreateCreditCard, type CreditCard } from '../models/creditCard.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolveCardRef } from './resolve.js'

export type DeleteCreditCardResult =
  | { deleted: true; card: string }
  | { deleted: false; dryRun: true; wouldDelete: { card: string; account: string; transactions: number; bills: number }; hint: string }

export const listCreditCards = (deps: Deps): Promise<CreditCard[]> => deps.creditCards.list()

export const deleteCreditCard = (
  deps: Deps,
  input: { card: string; confirm: boolean },
): ResultAsync<DeleteCreditCardResult, AppError> =>
  safeTry(async function* () {
    const card = yield* resolveCardRef(deps, input.card)
    const counts = await deps.creditCards.countCorrelated(card.id, card.accountId)

    if (!input.confirm)
      return ok({
        deleted: false as const,
        dryRun: true as const,
        wouldDelete: {
          card: card.name,
          account: `Card: ${card.name}`,
          transactions: counts.transactions,
          bills: counts.bills,
        },
        hint: 'Destructive action: show what would be deleted to the user and call again with confirm: true.',
      })

    await deps.creditCards.deleteCard(card.id, card.accountId)
    return ok({ deleted: true as const, card: card.name })
  })

export const createCreditCard = (
  deps: Deps,
  input: CreateCreditCard,
): ResultAsync<CreditCard, AppError> =>
  safeTry(async function* () {
    yield* guard(!(await deps.creditCards.findByName(input.name)), cardErrors.duplicateName(input.name))

    let paymentAccountId: string | undefined
    if (input.paymentAccount) {
      const paymentAccount = yield* resolveAccountRef(deps, input.paymentAccount)
      yield* guard(paymentAccount.type !== AccountType.enum.credit,
        validation(['payment account cannot be a credit account']))
      yield* guard(paymentAccount.currency === input.currency,
        validation([`currency mismatch: card is ${input.currency}, payment account is ${paymentAccount.currency}`]))
      paymentAccountId = paymentAccount.id
    }

    const internalAccountName = `Card: ${input.name}`
    yield* guard(!(await deps.accounts.findByName(internalAccountName)),
      accountErrors.duplicateName(internalAccountName))

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
