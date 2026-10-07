import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from './id.js';

/** Whether the HTTP surface demands a session. Derived from `HOST` unless set (ADR-033 §1). */
export const AuthMode = z.enum(['required', 'disabled']);
export type AuthMode = z.infer<typeof AuthMode>;

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;

/** The owner is inserted by migration on every database (ADR-033 §7) — this id must match the
 *  `INSERT` in `drizzle/0018_auth_identity.sql`; `test/integration/db/ownerMigration.test.ts` pins it. */
export const OWNER_USER_ID = 'user-owner';

/** The browser surface's root path — redirects are validated against it and `diplomat/http` mounts on it. */
export const UI_ROOT_PATH = '/ui';

export const USER_ENTITY_TAG = 'user';
export const SESSION_ENTITY_TAG = 'session';
export const SETUP_CODE_ENTITY_TAG = 'setup_code';
/** There is at most ONE setup code: issuing replaces it in place (ADR-033 §2), so concurrent starters can
 *  never leave two valid codes — the loser of the race retries into an update. */
export const SETUP_CODE_ID = 'setup-code';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A session never outlives this, however active — also the browser cookie's lifetime (the server's sliding
 *  idle expiry decides validity; the cookie just must not expire before the server would). */
export const SESSION_ABSOLUTE_MAX_MS = 30 * DAY_MS;

export const isUiPath = (path: string): boolean => path === UI_ROOT_PATH || path.startsWith(`${UI_ROOT_PATH}/`);

/** Entities the auth flows write — never worth telling a dashboard about. */
export const AUTH_ENTITY_TAGS: readonly string[] = [USER_ENTITY_TAG, SESSION_ENTITY_TAG, SETUP_CODE_ENTITY_TAG];

/** Where a login or setup lands when the caller named no (valid) destination. */
export const DEFAULT_LANDING_PATH = UI_ROOT_PATH;

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

/** What a request acts as — resolved at the HTTP edge from the session (or the owner, when auth is
 *  disabled or on stdio) and, from Phase 4, threaded into controllers as an explicit argument. */
export const PrincipalSchema = z.object({ userId: Id, role: UserRole });
export type Principal = z.infer<typeof PrincipalSchema>;

export const OWNER_PRINCIPAL: Principal = { userId: OWNER_USER_ID, role: UserRole.enum.admin };

/** Persistence-side user. `username`/`passwordHash` stay null until the owner is claimed (§7). */
export const UserEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    username: z.string().nullable().describe('Normalized (trimmed, lower-cased) login name'),
    passwordHash: z.string().nullable().describe('argon2id PHC string'),
    role: UserRole,
    createdAt: z.string(),
    disabledAt: z.string().nullable(),
  }),
);
export type UserEntity = z.infer<typeof UserEntitySchema>;

export const SessionEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    userId: Id,
    tokenHash: z.string().describe('sha256 of the session token — the token itself is never stored'),
    createdAt: z.string(),
    lastSeenAt: z.string(),
    expiresAt: z.string(),
  }),
);
export type SessionEntity = z.infer<typeof SessionEntitySchema>;

export const SetupCodeEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    codeHash: z.string().describe('sha256 of the setup code — the code itself is never stored'),
    createdAt: z.string(),
    expiresAt: z.string(),
    usedAt: z.string().nullable(),
  }),
);
export type SetupCodeEntity = z.infer<typeof SetupCodeEntitySchema>;

/** `username` is already normalized (`normalizeUsername`) — the schemas that produce these inputs do it. */
export type LoginInput = { username: string; password: string };
export type ClaimOwnerInput = { code: string; username: string; password: string };

/** A freshly started session — the plaintext token goes to the cookie and nowhere else. */
export type StartedSession = { token: string; expiresAt: string };

/** A setup code issued at startup — the plaintext goes to stderr once and nowhere else. */
export type IssuedSetupCode = { code: string; expiresAt: string };

export type AuthError =
  | { code: 'unauthenticated' }
  | { code: 'invalid_credentials' }
  | { code: 'invalid_setup_code' }
  | { code: 'setup_unavailable' }
  | { code: 'rate_limited' }
  | { code: 'forbidden_origin'; hint: string };

export const AUTH_MESSAGES = {
  invalidCredentials: 'Invalid username or password.',
  invalidSetupCode: 'That setup code is not valid or has expired. Restart FinTrack to get a new one.',
  setupUnavailable: 'Setup has already been completed. Log in instead.',
  rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  unauthenticated: 'Authentication required.',
  crossOrigin: 'Cross-origin request rejected.',
  crossOriginUnknownOrigin:
    "Cross-origin check could not determine this instance's own origin — set PUBLIC_URL to its external URL.",
  tryAgain: 'Could not complete the request. Try again.',
} as const;

export const authErrors = {
  unauthenticated: { code: 'unauthenticated' } satisfies AuthError,
  // One message for unknown user, wrong password, unclaimed owner and disabled user alike — the
  // response must not say which (ADR-033 §2).
  invalidCredentials: { code: 'invalid_credentials' } satisfies AuthError,
  // Wrong, expired and already-used codes are indistinguishable by design.
  invalidSetupCode: { code: 'invalid_setup_code' } satisfies AuthError,
  setupUnavailable: { code: 'setup_unavailable' } satisfies AuthError,
  rateLimited: { code: 'rate_limited' } satisfies AuthError,
  // CSRF (ADR-033 §2): a cookie-authenticated unsafe request whose Origin is not ours.
  crossOrigin: { code: 'forbidden_origin', hint: AUTH_MESSAGES.crossOrigin } satisfies AuthError,
  unknownOrigin: { code: 'forbidden_origin', hint: AUTH_MESSAGES.crossOriginUnknownOrigin } satisfies AuthError,
};
