import { randomBytes } from 'node:crypto'
import { Entry } from '@napi-rs/keyring'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Config } from '../../config.js'
import * as schema from './schema.js'

export type Db = LibSQLDatabase<typeof schema>

const KEYCHAIN_SERVICE = 'fintrack'
const KEYCHAIN_ACCOUNT = 'db-encryption-key'

const resolveEncryptionKey = (config: Config): string => {
  // Env-var override: CI, headless, or manual recovery (ADR-005).
  // The value must never be logged — callers must not surface it.
  if (config.FINTRACK_DB_KEY) return config.FINTRACK_DB_KEY

  const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)

  const existing = entry.getPassword()
  if (existing) return existing

  // First run: generate, persist, return.
  const key = randomBytes(32).toString('hex')
  entry.setPassword(key)
  return key
}

/** Open the encrypted libSQL database and return a Drizzle client. Fails fast if no key. */
export const openDatabase = (config: Config): Db => {
  const encryptionKey = resolveEncryptionKey(config)
  const client = createClient({ url: `file:${config.DB_PATH}`, encryptionKey })
  return drizzle(client, { schema })
}
