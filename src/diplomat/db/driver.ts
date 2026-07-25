import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Entry } from '@napi-rs/keyring';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { Config } from '../../config.js';
import * as schema from './schema.js';

export type Db = LibSQLDatabase<typeof schema>;

const KEYCHAIN_SERVICE = 'fintrack';
const KEYCHAIN_ACCOUNT = 'db-encryption-key';

// ADR-024: WAL lets readers (the HTTP sidecar) proceed without blocking the single writer, instead
// of rollback-journal's mutual blocking. busy_timeout makes a contended writer wait for the lock
// instead of throwing SQLITE_BUSY immediately — the common case for stdio spawned per client
// (ADR-007) when more than one is connected to the same file at once.
const JOURNAL_MODE_WAL = 'WAL';
const BUSY_TIMEOUT_MS = 5000;

const resolveEncryptionKey = (config: Config): string => {
  // Env-var override: CI, headless, or manual recovery (ADR-005). We log that we are in
  // env-var mode (never the key value itself) so the weaker posture is visible.
  if (config.FINTRACK_DB_KEY) {
    console.warn('fintrack: using FINTRACK_DB_KEY from the environment; OS keychain bypassed.');
    return config.FINTRACK_DB_KEY;
  }

  // Otherwise the key lives in the OS keychain (generated on first run). If the keychain
  // is unavailable (e.g. headless Linux without a Secret Service), fail fast with an
  // actionable message instead of an opaque native error.
  try {
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    const existing = entry.getPassword();
    if (existing) return existing;

    const key = randomBytes(32).toString('hex');
    entry.setPassword(key);
    return key;
  } catch (cause) {
    throw new Error(
      'fintrack: cannot access the OS keychain for the database encryption key. ' +
        'On headless or CI environments, provide a 64-character hex key via the ' +
        'FINTRACK_DB_KEY environment variable.',
      { cause },
    );
  }
};

/** Best-effort: WAL is verified to work with libSQL's encryption-at-rest in this project's target
 *  environments, but a build lacking WAL support degrades to busy_timeout + retry alone (ADR-024
 *  Consequences) rather than failing the whole DB open. */
const enableWal = async (client: ReturnType<typeof createClient>): Promise<void> => {
  try {
    await client.execute(`PRAGMA journal_mode = ${JOURNAL_MODE_WAL}`);
  } catch (cause) {
    // Not necessarily a WAL-support gap — could equally be a wrong key or a corrupt file, both of
    // which still surface their own real error on the next query. Worded neutrally rather than
    // diagnosing a cause this catch can't actually distinguish.
    console.warn('fintrack: could not enable WAL journal mode; continuing with busy_timeout + retry only.', cause);
  }
};

/**
 * Open the encrypted libSQL database and return a Drizzle client.
 * The encryption key comes from FINTRACK_DB_KEY or the OS keychain (generated on first
 * run); throws if neither is available so the DB is never opened unencrypted.
 */
export const openDatabase = async (config: Config): Promise<Db> => {
  const encryptionKey = resolveEncryptionKey(config);
  // mode 0o700 applies only when the directory is first created; pre-existing directories
  // keep their current permissions (Node does not retroactively tighten them).
  mkdirSync(dirname(config.DB_PATH), { recursive: true, mode: 0o700 });
  const client = createClient({ url: pathToFileURL(config.DB_PATH).href, encryptionKey });
  await enableWal(client);
  // busy_timeout is per-connection (ADR-024), so it is asserted unconditionally on every open.
  await client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return drizzle(client, { schema });
};
