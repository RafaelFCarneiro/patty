import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { err, ok, type Result } from 'neverthrow';
import { loadConfig } from '../config.js';
import type { Importer } from '../diplomat/cli/io.js';
import { CLI_MESSAGES } from '../diplomat/cli/messages.js';
import { countRowsOnCopy, DATABASE_COMPANION_SUFFIXES } from '../diplomat/db/database-files.js';
import { findEncryptionKey, keychainHoldsKey, storeKeychainKey } from '../diplomat/db/driver.js';
import { reasonOf } from '../models/error.js';
import { EXCLUSIVE_CREATE_FLAG, FILE_EXISTS_CODE, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from '../models/export.js';


/** Runs `work`, answering its failure as the Result track: a thrown reason is words, never a stack or a key. */
const attempt = async <T>(work: () => Promise<T>, failure: (cause: unknown) => string): Promise<Result<T, string>> => {
  try {
    return ok(await work());
  } catch (cause) {
    return err(failure(cause));
  }
};

/** A file that was already there is not ours to remove (`wx` refused it); anything we started is. */
const copyNewPrivateFile = async (from: string, to: string): Promise<void> => {
  mkdirSync(dirname(to), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    await pipeline(
      createReadStream(from),
      createWriteStream(to, { flags: EXCLUSIVE_CREATE_FLAG, mode: PRIVATE_FILE_MODE }),
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== FILE_EXISTS_CODE) rmSync(to, { force: true });
    throw cause;
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
  placeSnapshot: (snapshot) =>
    attempt(async () => {
      const { DB_PATH } = loadConfig();
      if (DATABASE_COMPANION_SUFFIXES.some((suffix) => existsSync(`${DB_PATH}${suffix}`))) {
        throw new Error(CLI_MESSAGES.databaseLeftovers(DB_PATH));
      }
      await copyNewPrivateFile(snapshot, DB_PATH);
    }, reasonOf),
});
