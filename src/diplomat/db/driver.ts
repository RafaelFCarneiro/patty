import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  // Env-var override: CI, headless, or manual recovery (ADR-005). We log that we are in
  // env-var mode (never the key value itself) so the weaker posture is visible.
  if (config.FINTRACK_DB_KEY) {
    console.warn('fintrack: using FINTRACK_DB_KEY from the environment; OS keychain bypassed.')
    return config.FINTRACK_DB_KEY
  }

  // Otherwise the key lives in the OS keychain (generated on first run). If the keychain
  // is unavailable (e.g. headless Linux without a Secret Service), fail fast with an
  // actionable message instead of an opaque native error.
  try {
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    const existing = entry.getPassword()
    if (existing) return existing

    const key = randomBytes(32).toString('hex')
    entry.setPassword(key)
    return key
  } catch (cause) {
    throw new Error(
      'fintrack: cannot access the OS keychain for the database encryption key. ' +
        'On headless or CI environments, provide a 64-character hex key via the ' +
        'FINTRACK_DB_KEY environment variable.',
      { cause },
    )
  }
}

/**
 * Open the encrypted libSQL database and return a Drizzle client.
 * The encryption key comes from FINTRACK_DB_KEY or the OS keychain (generated on first
 * run); throws if neither is available so the DB is never opened unencrypted.
 */
export const openDatabase = (config: Config): Db => {
  // mode 0o700: only the owner can read/list the directory — other local users must not access the DB
  mkdirSync(dirname(config.DB_PATH), { recursive: true, mode: 0o700 })
  const encryptionKey = resolveEncryptionKey(config)
  const client = createClient({ url: pathToFileURL(config.DB_PATH).href, encryptionKey })
  return drizzle(client, { schema })
}
