import { EncryptionKey } from '../models/encryption-key.js';
import { KEY_FILE_MAX_CHARACTERS, KeyImportRefusal, type KeySources } from '../models/key-import.js';

const TRAILING_NEWLINE = '\n';

/** The key a file holds — exactly what `key export` writes: the key and at most one trailing newline. Null for
 *  anything else; the contents are never echoed. */
export const decodeKeyFile = (contents: string): string | null => {
  if (contents.length > KEY_FILE_MAX_CHARACTERS) return null;
  const parsed = EncryptionKey.safeParse(
    contents.endsWith(TRAILING_NEWLINE) ? contents.slice(0, -TRAILING_NEWLINE.length) : contents,
  );
  return parsed.success ? parsed.data : null;
};

const REFUSALS = [
  [KeyImportRefusal.enum.key_file_configured, (sources) => sources.keyFileConfigured],
  [KeyImportRefusal.enum.key_env_configured, (sources) => sources.keyEnvConfigured],
  [KeyImportRefusal.enum.keychain_holds_key, (sources) => sources.keychainHoldsKey],
] as const satisfies readonly (readonly [KeyImportRefusal, (sources: KeySources) => boolean])[];

/** Why the keychain may not receive a key, or null when it may: a configured key file or env var is what the server
 *  reads instead, and an entry already in the keychain is replaced only by the person, deliberately. */
export const keyImportRefusal = (sources: KeySources): KeyImportRefusal | null =>
  REFUSALS.find(([, applies]) => applies(sources))?.[0] ?? null;
