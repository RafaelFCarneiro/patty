import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { computeBalance } from '../logic/balance.js'
import { resolveByName } from '../logic/resolve.js'
import type { Account, AccountBalance, AccountType, CreateAccount } from '../models/account.js'
import type { Deps } from './deps.js'
import { resolutionToResult } from './resolve.js'

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const all = await deps.accounts.list()
  return type ? all.filter((a) => a.type === type) : all
}

export const createAccount = (deps: Deps, input: CreateAccount): ResultAsync<Account, AppError> =>
  safeTry(async function* () {
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
  filter?: { account?: string; type?: AccountType },
): ResultAsync<AccountBalance[], AppError> =>
  safeTry(async function* () {
    const candidates = await listAccounts(deps, filter?.type)
    const accounts = filter?.account
      ? [yield* resolutionToResult(resolveByName(candidates, filter.account), 'account')]
      : candidates

    const balances: AccountBalance[] = []
    for (const account of accounts) {
      const parts = await deps.accounts.balanceParts(account.id)
      balances.push({
        ...account,
        ...parts,
        balance: computeBalance({ initialBalance: account.initialBalance, ...parts }),
      })
    }
    return ok(balances)
  })
