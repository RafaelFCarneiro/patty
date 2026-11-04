import { EncryptionKey } from '../models/encryption-key.js';
import { KEY_FILE_LINE_ENDINGS, KEY_FILE_MAX_CHARACTERS, KeyImportRefusal, type KeySources } from '../models/key-import.js';

/** The key a file holds: what `key export` writes (the key and a newline), with or without it, or with a CRLF. At most
 *  one line ending; null for anything else. The contents are never echoed. */
export const decodeKeyFile = (contents: string): string | null => {
  if (contents.length > KEY_FILE_MAX_CHARACTERS) return null;
  const ending = KEY_FILE_LINE_ENDINGS.find((candidate) => contents.endsWith(candidate));
  const parsed = EncryptionKey.safeParse(ending === undefined ? contents : contents.slice(0, -ending.length));
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
