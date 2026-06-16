import { Account } from '../models/account.js'
import type { CreateAccount } from '../models/account.js'
import { AccountRowSchema } from '../wire/db/accounts.js'
import type * as wireIn from '../wire/in/accounts.js'

export const dbToModel = (record: Record<string, unknown>): Account => {
  const row = AccountRowSchema.parse(record)
  return Account.parse({
    id:             row.id,
    name:           row.name,
    type:           row.type,
    initialBalance: row.initialBalance,
    currency:       row.currency,
  })
}

export const wireInToModel = (input: wireIn.CreateAccount): CreateAccount => input
