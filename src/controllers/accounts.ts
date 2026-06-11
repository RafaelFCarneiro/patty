import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import type { Account, CreateAccount } from '../models/account.js'
import type { Deps } from './deps.js'

export const listAccounts = (deps: Deps): Promise<Account[]> => deps.accounts.list()

export const createAccount = async (deps: Deps, input: CreateAccount): Promise<Result<Account, AppError>> => {
  const existing = await deps.accounts.findByName(input.name)
  if (existing) return err({ code: 'duplicate_name', entity: 'account', name: input.name })
  const account = await deps.accounts.create({ id: deps.newId(), ...input })
  return ok(account)
}
