import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import type { Account, AccountType, CreateAccount } from '../models/account.js'
import type { Deps } from './deps.js'

export const listAccounts = async (deps: Deps, type?: AccountType): Promise<Account[]> => {
  const all = await deps.accounts.list()
  return type ? all.filter((a) => a.type === type) : all
}

export const createAccount = async (deps: Deps, input: CreateAccount): Promise<Result<Account, AppError>> => {
  const existing = await deps.accounts.findByName(input.name)
  if (existing) return err({ code: 'duplicate_name', entity: 'account', name: input.name })
  const account = await deps.accounts.create({ id: deps.newId(), ...input })
  return ok(account)
}
