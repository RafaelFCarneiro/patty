import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { computeBalance } from '../logic/balance.js'
import { resolveByName } from '../logic/resolve.js'
import type { Account, AccountBalance, AccountType, CreateAccount } from '../models/account.js'
import type { Deps } from './deps.js'

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const all = await deps.accounts.list()
  return type ? all.filter((a) => a.type === type) : all
}

/** Balances are derived: initialBalance + income − expenses + transfers in − transfers out. */
export const getAccountBalances = async (
  deps: Deps,
  filter?: { account?: string; type?: AccountType },
): Promise<Result<AccountBalance[], AppError>> => {
  let accounts = await listAccounts(deps, filter?.type)
  if (filter?.account) {
    const res = resolveByName(accounts, filter.account)
    if (res.kind === 'none')
      return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
    if (res.kind === 'ambiguous')
      return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
    accounts = [res.entity]
  }

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
}

export const createAccount = async (deps: Deps, input: CreateAccount): Promise<Result<Account, AppError>> => {
  const existing = await deps.accounts.findByName(input.name)
  if (existing) return err({ code: 'duplicate_name', entity: 'account', name: input.name })
  const account = await deps.accounts.create({ id: deps.newId(), ...input })
  return ok(account)
}
