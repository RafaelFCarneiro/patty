import { existsSync } from 'node:fs';
import { err, ok, type Result } from 'neverthrow';
import { loadConfig } from '../config.js';
import type { Importer } from '../diplomat/cli/io.js';
import { CLI_MESSAGES } from '../diplomat/cli/messages.js';
import {
  countRowsOnCopy,
  discardStaged,
  hasDataBearingCompanion,
  publishStaged,
  stagePrivateCopy,
} from '../diplomat/db/database-files.js';
import { findEncryptionKey, keychainHoldsKey, storeKeychainKeyIfAbsent } from '../diplomat/db/driver.js';
import { reasonOf } from '../models/error.js';
import type { StagedCopy } from '../models/export.js';
import { KeyImportRefusal, type KeySources } from '../models/key-import.js';

const attempt = async <T>(work: () => Promise<T>, failure: (cause: unknown) => string): Promise<Result<T, string>> => {
  try {
    return ok(await work());
  } catch (cause) {
    return err(failure(cause));
  }
};

const refuseStaged = (staged: StagedCopy, snapshot: string): Result<StagedCopy, string> => {
  discardStaged(staged);
  return err(CLI_MESSAGES.snapshotNotStandalone(snapshot));
};

const readKeySources = async (): Promise<KeySources> => {
  const config = loadConfig();
  const keyFileConfigured = Boolean(config.FINTRACK_DB_KEY_FILE);
  const keyEnvConfigured = Boolean(config.FINTRACK_DB_KEY);
  return {
    keyFileConfigured,
    keyEnvConfigured,
    keychainHoldsKey: keyFileConfigured || keyEnvConfigured ? false : await keychainHoldsKey(),
  };
};

export const createImporter = (): Importer => ({
  databasePath: () => loadConfig().DB_PATH,
  keySources: () => attempt(readKeySources, reasonOf),
  proveAgainstDatabase: (key) => {
    const { DB_PATH } = loadConfig();
    if (!existsSync(DB_PATH)) return Promise.resolve(ok(undefined));
    return attempt(
      async () => void (await countRowsOnCopy(DB_PATH, key)),
      () => CLI_MESSAGES.keyDoesNotOpenDatabase(DB_PATH),
    );
  },
  storeKey: async (key) => {
    const stored = await attempt(() => storeKeychainKeyIfAbsent(key, loadConfig().KEY_LOCK_PATH), reasonOf);
    return stored.andThen((written) =>
      written ? ok(undefined) : err(CLI_MESSAGES.keyImportRefused(KeyImportRefusal.enum.keychain_holds_key)),
    );
  },
  resolveKey: async () => {
    const found = await attempt(() => findEncryptionKey(loadConfig()), reasonOf);
    return found.andThen((key) => (key === null ? err(CLI_MESSAGES.noKeyToImport) : ok(key)));
  },
  inspectSnapshot: (staged, key) =>
    attempt(
      () => countRowsOnCopy(staged.path, key),
      () => CLI_MESSAGES.keyDoesNotOpenSnapshot(staged.source),
    ),
  stageSnapshot: async (snapshot) => {
    const staged = await attempt(() => stagePrivateCopy(snapshot, loadConfig().DB_PATH), reasonOf);
    return staged.andThen((copy) => (hasDataBearingCompanion(snapshot) ? refuseStaged(copy, snapshot) : ok(copy)));
  },
  publishSnapshot: (staged) => attempt(() => publishStaged(staged, loadConfig().DB_PATH), reasonOf),
  discardSnapshot: discardStaged,
});
