import { ok, safeTry, type ResultAsync } from 'neverthrow'
import * as R from 'remeda'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import type { AccountPatch } from '../diplomat/db/repos/accounts.js'
import { filterByType, withTypeLabel } from '../logic/account.js'
import { computeBalance, computeProjectedBalance } from '../logic/balance.js'
import { resolveByName } from '../logic/resolve.js'
import { AccountType } from '../models/account.js'
import type { Account, AccountBalance, CreateAccount } from '../models/account.js'
import type { CurrencyCode } from '../models/common.js'
import type { Deps } from './deps.js'
import { resolveAccountRef, resolutionToResult } from './resolve.js'

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.accounts.list()])
  return R.pipe(
    all,
    R.filter(filterByType(type)),
    R.map(withTypeLabel(locale)),
  )
}

export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<Account, AppError> =>
  safeTry(async function* () {
    yield* guard(input.type !== AccountType.enum.credit, {
      code: 'validation',
      issues: ['credit accounts are created automatically with a credit card — use create_credit_card instead'],
    })
    yield* guard(!(await deps.accounts.findByName(input.name)), {
      code: 'duplicate_name',
      entity: 'account',
      name: input.name,
    })
    return ok(await deps.accounts.create({ id: deps.newId(), ...input }))
  })

/** Balances are derived: initialBalance + income − expenses + transfers in − transfers out. */
export const getAccountBalances = (
  deps: Deps,
  filter?: { account?: string; type?: AccountType; projectedAsOf?: string },
): ResultAsync<AccountBalance[], AppError> =>
  safeTry(async function* () {
    const candidates = await listAccounts(deps, filter?.type)
    const accounts = filter?.account
      ? [yield* resolutionToResult(resolveByName(candidates, filter.account), 'account')]
      : candidates

    const balances: AccountBalance[] = []
    for (const account of accounts) {
      const parts = await deps.accounts.balanceParts(account.id)
      const balance = computeBalance({ initialBalance: account.initialBalance, ...parts })

      const projectedBalance = filter?.projectedAsOf
        ? computeProjectedBalance(
            balance,
            await deps.transactions.pendingBalanceParts(account.id, filter.projectedAsOf),
          )
        : undefined

      balances.push({ ...account, ...parts, balance, projectedBalance })
    }
    return ok(balances)
  })

const CREDIT_ACCOUNT_REJECTION = {
  code: 'validation' as const,
  issues: ['credit accounts are managed by their credit card — use delete_credit_card / the card flow instead'],
}

export const deleteAccount = (deps: Deps, name: string): ResultAsync<{ deleted: boolean }, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, name)
    yield* guard(account.type !== AccountType.enum.credit, CREDIT_ACCOUNT_REJECTION)
    const refs = await deps.accounts.countReferences(account.id)
    yield* guard(refs.transactions === 0 && refs.recurring === 0 && refs.cards === 0, {
      code: 'in_use',
      entity: 'account',
      name: account.name,
      references: refs,
    })
    await deps.accounts.delete(account.id)
    return ok({ deleted: true })
  })

export type UpdateAccountInput = {
  name: string
  newName?: string
  initialBalance?: number
  type?: AccountType
  currency?: CurrencyCode
}

export const updateAccount = (deps: Deps, input: UpdateAccountInput): ResultAsync<Account, AppError> =>
  safeTry(async function* () {
    const account = yield* resolveAccountRef(deps, input.name)
    yield* guard(account.type !== AccountType.enum.credit, CREDIT_ACCOUNT_REJECTION)
    yield* guard(input.type !== AccountType.enum.credit, {
      code: 'validation',
      issues: ['type cannot be set to credit — credit accounts are created automatically with a credit card'],
    })

    if (input.newName && input.newName.toLowerCase() !== account.name.toLowerCase()) {
      yield* guard(!(await deps.accounts.findByName(input.newName)), {
        code: 'duplicate_name',
        entity: 'account',
        name: input.newName,
      })
    }

    if (input.type !== undefined || input.currency !== undefined) {
      const refs = await deps.accounts.countReferences(account.id)
      if (input.type !== undefined) {
        yield* guard(refs.transactions === 0, {
          code: 'validation',
          issues: [`type cannot be changed — account has ${refs.transactions} transaction(s)`],
        })
      }
      if (input.currency !== undefined) {
        yield* guard(refs.transactions === 0, {
          code: 'validation',
          issues: [`currency cannot be changed — account has ${refs.transactions} transaction(s)`],
        })
        yield* guard(refs.cards === 0, {
          code: 'validation',
          issues: ['currency cannot be changed — account is a credit card payment account'],
        })
      }
    }

    const patch: AccountPatch = {}
    if (input.newName !== undefined) patch.name = input.newName
    if (input.initialBalance !== undefined) patch.initialBalance = input.initialBalance
    if (input.type !== undefined) patch.type = input.type
    if (input.currency !== undefined) patch.currency = input.currency

    const locale = await deps.locale()
    return ok(withTypeLabel(await deps.accounts.update(account.id, patch), locale))
  })
