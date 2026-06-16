import { Account } from '../models/account.js'
import type { CreateAccount } from '../models/account.js'
import type * as wireIn from '../wire/in/accounts.js'

export const dbToModel = (record: Record<string, unknown>): Account =>
  Account.parse({
    id:             record['id'],
    name:           record['name'],
    type:           record['type'],
    initialBalance: record['initialBalance'] ?? record['initial_balance'],
    currency:       record['currency'],
  })

export const wireInToModel = (input: wireIn.CreateAccount): CreateAccount => input
