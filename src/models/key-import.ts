import { z } from 'zod';

export type KeySources = {
  keyFileConfigured: boolean;
  keyEnvConfigured: boolean;
  keychainHoldsKey: boolean;
};

export const KeyImportRefusal = z.enum(['key_file_configured', 'key_env_configured', 'keychain_holds_key']);
export type KeyImportRefusal = z.infer<typeof KeyImportRefusal>;

export const KEY_FILE_LINE_ENDINGS = ['\r\n', '\n'] as const;

export const KEY_FILE_MAX_CHARACTERS = 64 + Math.max(...KEY_FILE_LINE_ENDINGS.map((ending) => ending.length));

export const KEY_LOCK_WAIT_MS = 60_000;
export const KEY_LOCK_RETRY_MS = 50;
