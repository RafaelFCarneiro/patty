import { z } from 'zod';

/** The database encryption key: 64 hex characters (32 bytes). Shared by every key source — the env var is decoded in
 *  `config.ts`, the key file's contents in `diplomat/db/driver.ts` and `logic/key-import.ts`. */
export const EncryptionKey = z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-character hex string');
