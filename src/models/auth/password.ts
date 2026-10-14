import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
// Argon2 caps nothing, but an unbounded body is a CPU/memory lever for anyone who can reach /ui/login.
export const PASSWORD_MAX_LENGTH = 1024;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 64;
const USERNAME_PATTERN = /^[\p{L}\p{N}._@+-]+$/u;

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

/** Stored form of a username — what makes the UNIQUE index case-insensitive. Every schema that accepts a
 *  username normalizes through it, so a `LoginInput`/`ClaimOwnerInput` reaching a controller already holds it. */
export const normalizeUsername = (raw: string): string => raw.trim().normalize('NFKC').toLowerCase();

// Normalize FIRST, then validate the stored form: NFKC can expand a character (`ﬃ` → `ffi`), so checking the
// length of the raw input would let the schema emit a username longer than its own policy allows.
export const UsernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(USERNAME_MIN_LENGTH, `username must be at least ${USERNAME_MIN_LENGTH} characters`)
      .max(USERNAME_MAX_LENGTH)
      .regex(USERNAME_PATTERN, 'username may contain letters, digits and . _ @ + -'),
  );

/** `username` is already normalized (`normalizeUsername`) — the schemas that produce these inputs do it. */
export type LoginInput = { username: string; password: string };
export type ClaimOwnerLocallyInput = { username: string; password: string };
export type ClaimOwnerInput = ClaimOwnerLocallyInput & { code: string };

/** `username` absent means the owner — the only user until ADR-033 Phase 4. */
export type ResetPasswordInput = { username?: string; password: string };

export type PasswordReset = { username: string; sessionsEnded: number; tokensRevoked: number };
