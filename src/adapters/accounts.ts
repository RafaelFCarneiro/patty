import { type Account, AccountSchema } from '../models/account.js'
import type { CreateAccount, UpdateAccount } from '../models/account.js'
import type { AccountRow } from '../wire/db/accounts.js'
import type * as wireIn from '../wire/in/accounts.js'

export const dbToModel = (row: AccountRow): Account =>
  AccountSchema.parse({
    id:             row.id,
    name:           row.name,
    type:           row.type,
    initialBalance: row.initialBalance,
    currency:       row.currency,
  })

export const createWireInToModel = (input: wireIn.CreateAccount): CreateAccount => input
export const updateWireInToModel = (input: wireIn.UpdateAccount): UpdateAccount => input
