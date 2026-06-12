import { Account } from '../models/account.js'
import type { CreateAccount } from '../models/account.js'
import type * as wireIn from '../wire/in/accounts.js'

type NodeLike = { properties: Record<string, unknown> }
const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

export const dbToModel = (record: Record<string, unknown>): Account =>
  Account.parse({ ...props(record['a']), currency: record['currency'] })

export const wireInToModel = (input: wireIn.CreateAccount): CreateAccount => input
