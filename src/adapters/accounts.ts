import { Account } from '../models/account.js'

type NodeLike = { properties: Record<string, unknown> }
const props = (v: unknown): Record<string, unknown> => (v as NodeLike).properties

export const dbToModel = (record: Record<string, unknown>): Account =>
  Account.parse({ ...props(record['a']), currency: record['currency'] })
