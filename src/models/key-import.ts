import { z } from 'zod';

/** Where the server could already be reading its database key from, besides the OS keychain. */
export type KeySources = {
  keyFileConfigured: boolean;
  keyEnvConfigured: boolean;
  keychainHoldsKey: boolean;
};

/** Why a key may not be imported into the OS keychain. */
export const KeyImportRefusal = z.enum(['key_file_configured', 'key_env_configured', 'keychain_holds_key']);
export type KeyImportRefusal = z.infer<typeof KeyImportRefusal>;

/** A key file is the key and at most one newline: nothing longer is one. */
export const KEY_FILE_MAX_CHARACTERS = 65;
