import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { EncryptionKey, type Config } from '../../config.js';
import { KEYCHAIN_SERVICE } from '../../models/auth.js';
import * as schema from './schema.js';

export type Db = LibSQLDatabase<typeof schema>;

/** The transaction handle `db.transaction` hands its callback — inferred from `Db` itself rather
 *  than naming a drizzle-internal type directly. `driver.ts` is the SQLite adapter (ADR-030): the
 *  sole place this concrete handle is derived from `Db`. Re-exported from `diplomat/db/effects.ts`
 *  (the engine's port, generic over an opaque `TTx`) so every existing import path there still
 *  resolves. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const KEYCHAIN_ACCOUNT = 'db-encryption-key';

// ADR-024: WAL lets readers (the HTTP sidecar) proceed without blocking the single writer, instead
// of rollback-journal's mutual blocking. busy_timeout makes a contended writer wait for the lock
// instead of throwing SQLITE_BUSY immediately — the common case for stdio spawned per client
// (ADR-007) when more than one is connected to the same file at once.
const JOURNAL_MODE_WAL = 'WAL';
export const BUSY_TIMEOUT_MS = 5000;

/** `busy_timeout` is per connection (ADR-024) and libsql opens a fresh connection after every transaction, so
 *  anything that has just run one re-asserts it on the connection that follows. */
export const assertBusyTimeout = (client: ReturnType<typeof createClient>): Promise<unknown> =>
  client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

type DbConfig = Pick<Config, 'DB_PATH' | 'FINTRACK_DB_KEY' | 'FINTRACK_DB_KEY_FILE'>;

const KEY_GENERATION_HINT =
  'Generate one with `openssl rand -hex 32` and provide it via FINTRACK_DB_KEY_FILE ' +
  '(e.g. a Docker secret mounted at /run/secrets/fintrack_db_key) or the FINTRACK_DB_KEY environment variable.';

const readKeyFile = (path: string): string => {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `fintrack: cannot read the encryption key file FINTRACK_DB_KEY_FILE (${path}). ${KEY_GENERATION_HINT}`,
      { cause },
    );
  }
  const parsed = EncryptionKey.safeParse(contents.trim());
  if (!parsed.success) {
    throw new Error(
      `fintrack: FINTRACK_DB_KEY_FILE (${path}) must contain a 64-character hex key (a trailing newline is fine). ${KEY_GENERATION_HINT}`,
    );
  }
  return parsed.data;
};

// The only place the native keychain module is loaded, so the file/env key paths never load it (ADR-032).
const loadKeyring = () => import('@napi-rs/keyring');

// A hand-edited or corrupted keychain entry must fail here with a clear message, not reach libSQL.
const validateStoredKey = (stored: string): string => {
  const parsed = EncryptionKey.safeParse(stored);
  if (!parsed.success) {
    throw new Error(
      'fintrack: the encryption key stored in the OS keychain is not a 64-character hex key. ' +
        'Remove the "fintrack" / "db-encryption-key" keychain entry (this loses access to an existing database ' +
        `encrypted with it), or supply the correct key. ${KEY_GENERATION_HINT}`,
    );
  }
  return parsed.data;
};

const resolveKeychainKey = async (): Promise<string> => {
  try {
    const { Entry } = await loadKeyring();
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    const existing = entry.getPassword();
    if (existing) return existing;

    const key = randomBytes(32).toString('hex');
    entry.setPassword(key);
    return key;
  } catch (cause) {
    throw new Error(
      `fintrack: cannot access the OS keychain for the database encryption key, and no key source was configured. ${KEY_GENERATION_HINT}`,
      { cause },
    );
  }
};

// Order: key file -> env var -> OS keychain. The key is never written next to the data: the
// keychain generates on first run for local use only, and every other path fails fast.
export const resolveEncryptionKey = async (config: DbConfig): Promise<string> => {
  if (config.FINTRACK_DB_KEY_FILE) {
    console.warn('fintrack: using the encryption key from FINTRACK_DB_KEY_FILE; OS keychain bypassed.');
    return readKeyFile(config.FINTRACK_DB_KEY_FILE);
  }
  // Env-var override: CI, headless, or manual recovery (ADR-005). We log that we are in
  // env-var mode (never the key value itself) so the weaker posture is visible.
  if (config.FINTRACK_DB_KEY) {
    console.warn('fintrack: using FINTRACK_DB_KEY from the environment; OS keychain bypassed.');
    return config.FINTRACK_DB_KEY;
  }
  return validateStoredKey(await resolveKeychainKey());
};

/** Best-effort: WAL is verified to work with libSQL's encryption-at-rest in this project's target
 *  environments, but a build lacking WAL support degrades to busy_timeout + retry alone (ADR-024
 *  Consequences) rather than failing the whole DB open. `PRAGMA journal_mode = WAL` does not throw
 *  when WAL can't be applied — SQLite silently keeps the prior mode and reports it back in the
 *  result row — so the applied mode is checked explicitly, not just the thrown-exception path.
 *  Exported so the silent-fallback path (unreachable through `openDatabase`'s always-file-backed
 *  `DB_PATH`) has direct unit coverage against a real in-memory client. */
export const enableWal = async (client: ReturnType<typeof createClient>): Promise<void> => {
  try {
    const result = await client.execute(`PRAGMA journal_mode = ${JOURNAL_MODE_WAL}`);
    const appliedMode = result.rows[0]?.journal_mode;
    if (typeof appliedMode !== 'string' || appliedMode.toUpperCase() !== JOURNAL_MODE_WAL) {
      console.warn(
        `fintrack: WAL journal mode was not applied (sqlite reports "${String(appliedMode)}"); ` +
          'continuing with busy_timeout + retry only.',
      );
    }
  } catch (cause) {
    // Not necessarily a WAL-support gap — could equally be a wrong key or a corrupt file, both of
    // which still surface their own real error on the next query. Worded neutrally rather than
    // diagnosing a cause this catch can't actually distinguish.
    console.warn('fintrack: could not enable WAL journal mode; continuing with busy_timeout + retry only.', cause);
  }
};

/**
 * Open the encrypted libSQL database and return a Drizzle client.
 * The encryption key comes from FINTRACK_DB_KEY_FILE, FINTRACK_DB_KEY or the OS keychain (generated
 * on first run); throws if none is available so the DB is never opened unencrypted.
 */
export const openDatabase = async (config: DbConfig): Promise<Db> => {
  const encryptionKey = await resolveEncryptionKey(config);
  // mode 0o700 applies only when the directory is first created; pre-existing directories
  // keep their current permissions (Node does not retroactively tighten them).
  mkdirSync(dirname(config.DB_PATH), { recursive: true, mode: 0o700 });
  const client = createClient({ url: pathToFileURL(config.DB_PATH).href, encryptionKey });
  await enableWal(client);
  // busy_timeout is per-connection (ADR-024), so it is asserted unconditionally on every open.
  await assertBusyTimeout(client);
  return drizzle(client, { schema });
};

/** Releases the libSQL connection a short-lived process (the CLI) opened, so it can end by itself. Drizzle keeps
 *  the client on `$client` at runtime without typing it on `LibSQLDatabase`. */
export const closeDatabase = (db: Db): void => {
  (db as Db & { $client?: ReturnType<typeof createClient> }).$client?.close();
};

/** Adapts libSQL Drizzle's `Db.transaction` to the effect engine's `TransactionRunner` port
 *  (ADR-030 Phase 1) — `diplomat/db/effects.ts`'s `runEffects`/`runEffectsSequence` call
 *  `runInTransaction` and never name `Db.transaction` directly; this is the one place, at the
 *  composition root's binding, that still does. No explicit return-type annotation: the object
 *  literal structurally satisfies `TransactionRunner<Tx>` without this adapter-side file importing
 *  that port type from the engine. */
export const createTransactionRunner = (db: Db) => ({
  runInTransaction: <T>(work: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(work),
});
