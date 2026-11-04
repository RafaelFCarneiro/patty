import { existsSync } from 'node:fs';
import { err, ok, type Result } from 'neverthrow';
import { loadConfig } from '../config.js';
import type { Importer } from '../diplomat/cli/io.js';
import { CLI_MESSAGES } from '../diplomat/cli/messages.js';
import { copyNewPrivateFile, countRowsOnCopy } from '../diplomat/db/database-files.js';
import { findEncryptionKey, keychainHoldsKey, storeKeychainKey } from '../diplomat/db/driver.js';
import { reasonOf } from '../models/error.js';

/** Runs `work`, answering its failure as the Result track: a thrown reason is words, never a stack or a key. */
const attempt = async <T>(work: () => Promise<T>, failure: (cause: unknown) => string): Promise<Result<T, string>> => {
  try {
    return ok(await work());
  } catch (cause) {
    return err(failure(cause));
  }
};

export const createImporter = (): Importer => ({
  databasePath: () => loadConfig().DB_PATH,
  keySources: () =>
    attempt(async () => {
      const config = loadConfig();
      const keyFileConfigured = Boolean(config.FINTRACK_DB_KEY_FILE);
      const keyEnvConfigured = Boolean(config.FINTRACK_DB_KEY);
      // A configured source is refused anyway: the keychain is not consulted for it (a headless host may have none).
      return {
        keyFileConfigured,
        keyEnvConfigured,
        keychainHoldsKey: keyFileConfigured || keyEnvConfigured ? false : await keychainHoldsKey(),
      };
    }, reasonOf),
  proveAgainstDatabase: (key) => {
    const { DB_PATH } = loadConfig();
    if (!existsSync(DB_PATH)) return Promise.resolve(ok(undefined));
    return attempt(
      async () => void (await countRowsOnCopy(DB_PATH, key)),
      () => CLI_MESSAGES.keyDoesNotOpenDatabase(DB_PATH),
    );
  },
  storeKey: (key) => attempt(() => storeKeychainKey(key), reasonOf),
  resolveKey: async () => {
    const found = await attempt(() => findEncryptionKey(loadConfig()), reasonOf);
    return found.andThen((key) => (key === null ? err(CLI_MESSAGES.noKeyToImport) : ok(key)));
  },
  inspectSnapshot: (snapshot, key) =>
    attempt(
      () => countRowsOnCopy(snapshot, key),
      () => CLI_MESSAGES.keyDoesNotOpenSnapshot(snapshot),
    ),
  placeSnapshot: (snapshot) => attempt(() => copyNewPrivateFile(snapshot, loadConfig().DB_PATH), reasonOf),
});
