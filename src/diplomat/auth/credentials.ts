import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { AuthSecrets } from '../../controllers/deps.js';
import { TOKEN_PREFIX } from '../../models/auth.js';

// OWASP Password Storage Cheat Sheet, first-choice argon2id parameters. `@node-rs/argon2` defaults to
// argon2id when no algorithm is given (its `Algorithm` enum is not available at runtime to import).
const ARGON2_MEMORY_COST_KIB = 47_104;
const ARGON2_TIME_COST = 1;
const ARGON2_PARALLELISM = 1;
const ARGON2_OPTIONS = {
  memoryCost: ARGON2_MEMORY_COST_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
} as const;

const TOKEN_BYTES = 32; // 256 bits — session tokens and access tokens alike
const TOKEN_ENCODING = 'base64url';
const HASH_ALGORITHM = 'sha256';
const HASH_ENCODING = 'hex';

// Crockford base32: 32 symbols with no I, L, O or U, so a code survives being read aloud or retyped.
// 20 symbols = 100 bits. 32 divides 256, so `byte & 31` is unbiased.
const SETUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SETUP_CODE_LENGTH = 20;
const SETUP_CODE_SYMBOL_MASK = SETUP_CODE_ALPHABET.length - 1;

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2_OPTIONS);

/** Constant-time compare inside argon2; an unparseable stored hash is a mismatch, never an exception. */
export const verifyPassword = async (storedHash: string, password: string): Promise<boolean> => {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
};

export const randomToken = (): string => randomBytes(TOKEN_BYTES).toString(TOKEN_ENCODING);

/** `ftk_` + 32 random bytes, base64url — the prefix keeps a leaked token greppable (ADR-033 §3). */
export const randomAccessToken = (): string =>
  `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString(TOKEN_ENCODING)}`;

export const randomSetupCode = (): string =>
  Array.from(randomBytes(SETUP_CODE_LENGTH), (byte) => SETUP_CODE_ALPHABET[byte & SETUP_CODE_SYMBOL_MASK]).join('');

export const hashSecret = (secret: string): string => createHash(HASH_ALGORITHM).update(secret).digest(HASH_ENCODING);

/** The real `AuthSecrets`. Built once at startup: it hashes a throwaway password so unknown-user logins
 *  have a genuine argon2id hash to verify against. */
export const createSecrets = async (): Promise<AuthSecrets> => ({
  hashPassword,
  verifyPassword,
  randomToken,
  randomAccessToken,
  randomSetupCode,
  hashSecret,
  dummyPasswordHash: await hashPassword(randomToken()),
});
