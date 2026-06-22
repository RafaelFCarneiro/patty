import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { computeBalance, computeProjectedBalance } from '../logic/balance.js'
import { localizeAccountType } from '../logic/labels.js'
import { resolveByName } from '../logic/resolve.js'
import { AccountType } from '../models/account.js'
import type { Account, AccountBalance, CreateAccount } from '../models/account.js'
import type { Locale } from '../models/locale.js'
import type { Deps } from './deps.js'
import { resolutionToResult } from './resolve.js'

const withTypeLabel = <T extends Account>(account: T, locale: Locale): T => ({
  ...account,
  typeLabel: localizeAccountType(account.type, locale),
})

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const [locale, all] = await Promise.all([deps.locale(), deps.accounts.list()])
  const filtered = type ? all.filter((a) => a.type === type) : all
  return filtered.map((a) => withTypeLabel(a, locale))
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
