import { Account } from '../models/account.js'
import type { CreateAccount } from '../models/account.js'
import type { AccountRow } from '../wire/db/accounts.js'
import type * as wireIn from '../wire/in/accounts.js'

// Input is the schema-derived Drizzle row; Account.parse enforces domain constraints.
export const dbToModel = (row: AccountRow): Account =>
  Account.parse({
    id:             row.id,
    name:           row.name,
    type:           row.type,
    initialBalance: row.initialBalance,
    currency:       row.currency,
  })

export const wireInToModel = (input: wireIn.CreateAccount): CreateAccount => input
