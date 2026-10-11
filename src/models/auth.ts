import { z } from 'zod';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { Id } from './id.js';

/** Whether the HTTP surface demands a session. `disabled` is an explicit, loopback-only opt-out. */
export const AuthMode = z.enum(['required', 'disabled']);
export type AuthMode = z.infer<typeof AuthMode>;
/** What `FINTRACK_AUTH` means when unset — on every surface, loopback included. */
export const DEFAULT_AUTH_MODE = AuthMode.enum.required;

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;

/** What a credential may do (ADR-033 §3). `fintrack:write` implies `fintrack:read` — see `logic/auth.ts`'s
 *  `hasScope`. The values are the OAuth scope strings clients see in challenges and metadata. */
export const Scope = z.enum(['fintrack:read', 'fintrack:write']);
export type Scope = z.infer<typeof Scope>;
export const ALL_SCOPES: readonly Scope[] = Scope.options;
export const READ_SCOPE = Scope.enum['fintrack:read'];
export const WRITE_SCOPE = Scope.enum['fintrack:write'];

/** How a request authenticated, so the edge can tell a browser session from a bearer token from the trusted
 *  owner of a stdio / auth-disabled run. */
export const PrincipalVia = z.enum(['session', 'token', 'owner']);
export type PrincipalVia = z.infer<typeof PrincipalVia>;

/** The owner is inserted by migration on every database (ADR-033 §7) — this id must match the
 *  `INSERT` in `drizzle/0018_auth_identity.sql`; `test/integration/db/ownerMigration.test.ts` pins it. */
export const OWNER_USER_ID = 'user-owner';

/** The browser surface's root path — redirects are validated against it and `diplomat/http` mounts on it. */
export const UI_ROOT_PATH = '/ui';

export const USER_ENTITY_TAG = 'user';
export const SESSION_ENTITY_TAG = 'session';
export const SETUP_CODE_ENTITY_TAG = 'setup_code';
export const ACCESS_TOKEN_ENTITY_TAG = 'access_token';
/** There is at most ONE setup code: issuing replaces it in place (ADR-033 §2), so concurrent starters can
 *  never leave two valid codes — the loser of the race retries into an update. */
export const SETUP_CODE_ID = 'setup-code';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
export const DAY_MS = 24 * 60 * MINUTE_MS;

/** A session dies after this long without being seen (sliding)… */
export const SESSION_IDLE_TTL_MS = 7 * DAY_MS;
/** `last_seen_at`/`expires_at` are rewritten at most this often — not on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE_MS;
export const SETUP_CODE_TTL_MS = 30 * MINUTE_MS;

export const SETUP_CODE_GROUP_SIZE = 4;
export const SETUP_CODE_GROUP_SEPARATOR = '-';
export const NON_ALPHANUMERIC = /[^A-Za-z0-9]/g;

export const READ_METHODS = ['GET', 'HEAD'];
export const SAFE_METHODS: ReadonlySet<string> = new Set([...READ_METHODS, 'OPTIONS']);
export const OPAQUE_ORIGIN = 'null';
export const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

export const MCP_TOOLS_CALL_METHOD = 'tools/call';

export const BEARER_SCHEME = 'Bearer';
export const BEARER_HEADER = new RegExp(`^${BEARER_SCHEME}[ \\t]+(\\S+)$`, 'i');
export const MAX_TOKEN_LENGTH = 256;

export const RESOURCE_NAME = 'FinTrack';
export const BEARER_METHOD_HEADER = 'header';
/** A session never outlives this, however active — also the browser cookie's lifetime (the server's sliding
 *  idle expiry decides validity; the cookie just must not expire before the server would). */
export const SESSION_ABSOLUTE_MAX_MS = 30 * DAY_MS;

export const isUiPath = (path: string): boolean => path === UI_ROOT_PATH || path.startsWith(`${UI_ROOT_PATH}/`);

/** Entities the auth flows write — never worth telling a dashboard about. */
export const AUTH_ENTITY_TAGS: readonly string[] = [
  USER_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  ACCESS_TOKEN_ENTITY_TAG,
];

/** The HTTP surfaces a bearer token is accepted on. `/ui` is a browser surface and stays session-only. */
export const API_PATH_PREFIX = '/api';
export const MCP_PATH = '/mcp';
/** RFC 9728 §3: the metadata of resource `<origin>/mcp` lives at the well-known URI with the path inserted. */
export const PRM_WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';
export const MCP_PRM_PATH = `${PRM_WELL_KNOWN_PATH}${MCP_PATH}`;

/** Every personal access token starts with this, so a leaked one is greppable (ADR-033 §3). */
export const TOKEN_PREFIX = 'ftk_';
/** How many characters of the random part are kept, in clear, to tell tokens apart in the list. */
export const TOKEN_DISPLAY_PREFIX_RANDOM_CHARS = 6;
export const TOKEN_NAME_MAX_LENGTH = 80;
/** The MCP `AuthInfo.clientId` of a request made with a personal access token: `pat:<token id>`. */
export const PAT_CLIENT_ID_PREFIX = 'pat:';

/** Expiry choices for a new token — there is no "never". A legacy row may still hold a null `expires_at`. */
export const TokenExpiry = z.enum(['30', '90', '365']);
export type TokenExpiry = z.infer<typeof TokenExpiry>;
/** What the token form preselects. */
export const DEFAULT_TOKEN_EXPIRY = TokenExpiry.enum['90'];
export const TOKEN_EXPIRY_DAYS: Readonly<Record<TokenExpiry, number>> = {
  '30': 30,
  '90': 90,
  '365': 365,
};

/** The two access levels the token form offers; `write` includes `read`. */
export const TokenAccess = z.enum(['read', 'write']);
export type TokenAccess = z.infer<typeof TokenAccess>;
export const TOKEN_ACCESS_SCOPES: Readonly<Record<TokenAccess, readonly Scope[]>> = {
  read: [READ_SCOPE],
  write: [READ_SCOPE, WRITE_SCOPE],
};

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

/** What a request acts as — resolved at the HTTP edge from the session or bearer token (or the owner, when
 *  auth is disabled or on stdio) and, from Phase 4, threaded into controllers as an explicit argument.
 *  A session and the owner hold every scope; a token holds the scopes it was minted with. */
export const PrincipalSchema = z.object({
  userId: Id,
  role: UserRole,
  scopes: z.array(Scope),
  via: PrincipalVia,
  /** The access token this request presented — only when `via` is `token`. */
  tokenId: Id.optional(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const OWNER_PRINCIPAL: Principal = {
  userId: OWNER_USER_ID,
  role: UserRole.enum.admin,
  scopes: [...ALL_SCOPES],
  via: PrincipalVia.enum.owner,
};

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
export type ClaimedUserEntity = UserEntity & { username: string; passwordHash: string };

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

/** A personal access token (ADR-033 §3). Only `sha256(token)` and a display prefix are stored. */
export const AccessTokenEntitySchema = withPersistenceMeta(
  z.object({
    id: Id,
    userId: Id,
    name: z.string().min(1).max(TOKEN_NAME_MAX_LENGTH),
    tokenHash: z.string().describe('sha256 of the token — the token itself is never stored'),
    prefix: z.string().describe('`ftk_` + the first characters of the random part, for display only'),
    scopes: z.array(Scope).min(1),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  }),
);
export type AccessTokenEntity = z.infer<typeof AccessTokenEntitySchema>;

export const TokenStatus = z.enum(['active', 'expired', 'revoked']);
export type TokenStatus = z.infer<typeof TokenStatus>;

/** What the token list shows — everything but the hash. */
export type AccessTokenSummary = Omit<AccessTokenEntity, 'tokenHash' | 'version'> & { status: TokenStatus };

/** A freshly minted token — the plaintext is shown once and never stored or logged. */
export type CreatedAccessToken = { token: string; summary: AccessTokenSummary };

export type NewTokenSpec = { name: string; access: TokenAccess; expiry: TokenExpiry };

/** Creating a token asks for the login password again (step-up): a script that runs in the dashboard's origin
 *  holds the session cookie but not the password, so it cannot mint a token for itself. */
export type CreateTokenInput = NewTokenSpec & { password: string };

/** `username` is already normalized (`normalizeUsername`) — the schemas that produce these inputs do it. */
export type LoginInput = { username: string; password: string };
export type ClaimOwnerLocallyInput = { username: string; password: string };
export type ClaimOwnerInput = ClaimOwnerLocallyInput & { code: string };

/** `username` absent means the owner — the only user until ADR-033 Phase 4. */
export type ResetPasswordInput = { username?: string; password: string };

export type ClaimedOwner = { username: string };

export type ClaimPlan = { kind: 'claim' } | { kind: 'skip'; username: string };

export type PasswordReset = { username: string; sessionsEnded: number; tokensRevoked: number };

/** A freshly started session — the plaintext token goes to the cookie and nowhere else. */
export type StartedSession = { token: string; expiresAt: string };

/** A setup code issued at startup — the plaintext goes to stderr once and nowhere else. */
export type IssuedSetupCode = { code: string; expiresAt: string };

/** Whether a session or token is still good, and whether its `last_seen`/`last_used` is stale enough to rewrite. */
export type SessionVerdict = { kind: 'invalid' } | { kind: 'valid'; touch: boolean };
export type TokenVerdict = SessionVerdict;

/** Everything the same-origin (CSRF) decision reads from a request. */
export type CsrfRequest = {
  method: string;
  publicUrl: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
};

/** The one JSON-RPC message shape `requiredMcpScope` looks at. */
export type JsonRpcMessage = { method?: unknown; params?: { name?: unknown } | null };

export type Credential = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'malformed' };

/** A token's fields before it has been written (no `version` yet). */
export type TokenFields = Omit<AccessTokenEntity, 'version'>;

export type AuthError =
  | { code: 'unauthenticated' }
  | { code: 'invalid_credentials' }
  | { code: 'invalid_setup_code' }
  | { code: 'setup_unavailable' }
  | { code: 'unknown_user'; username: string }
  | { code: 'owner_unclaimed' }
  | { code: 'rate_limited' }
  | { code: 'forbidden_origin'; hint: string }
  | { code: 'invalid_token' }
  | { code: 'insufficient_scope'; scope: Scope }
  | { code: 'unknown_token'; id: string }
  | { code: 'session_required' }
  | { code: 'resource_metadata_unavailable'; hint: string };

/** The terminal route to the same owner claim as `/ui/setup` — shown wherever the setup code is. */
export const PACKAGE_NAME = '@rafaelfcarneiro/fintrack';
export const TERMINAL_SETUP_COMMAND = `npx ${PACKAGE_NAME} auth setup`;
export const TERMINAL_SETUP_HINT = `or run \`${TERMINAL_SETUP_COMMAND}\` in a terminal`;

export const AUTH_MESSAGES = {
  invalidCredentials: 'Invalid username or password.',
  invalidSetupCode: 'That setup code is not valid or has expired. Restart FinTrack to get a new one.',
  setupUnavailable: 'Setup has already been completed. Log in instead.',
  unknownUser: 'No such user.',
  ownerUnclaimed: `The owner has no login yet. Run \`${TERMINAL_SETUP_COMMAND}\` first.`,
  rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  unauthenticated: 'Authentication required.',
  crossOrigin: 'Cross-origin request rejected.',
  crossOriginUnknownOrigin:
    "Cross-origin check could not determine this instance's own origin — set PUBLIC_URL to its external URL.",
  tryAgain: 'Could not complete the request. Try again.',
  invalidToken: 'The access token is invalid, expired or revoked.',
  invalidPassword: 'That password is not correct.',
  insufficientScope: 'The access token does not grant the scope this operation needs.',
  unknownToken: 'No such access token.',
  sessionRequired: 'Access tokens can only be managed from a signed-in browser session.',
  prmNeedsOrigin:
    'This instance cannot say what its own origin is — set PUBLIC_URL to its external URL to publish its ' +
    'Protected Resource Metadata.',
  nonLoopbackRequest:
    'Request host/origin is not loopback — FinTrack without authentication only answers 127.0.0.1, localhost or ' +
    '::1. To use another hostname, set PUBLIC_URL (which turns authentication on).',
} as const;

export const authErrors = {
  unauthenticated: { code: 'unauthenticated' } satisfies AuthError,
  // One message for unknown user, wrong password, unclaimed owner and disabled user alike — the
  // response must not say which (ADR-033 §2).
  invalidCredentials: { code: 'invalid_credentials' } satisfies AuthError,
  // Wrong, expired and already-used codes are indistinguishable by design.
  invalidSetupCode: { code: 'invalid_setup_code' } satisfies AuthError,
  setupUnavailable: { code: 'setup_unavailable' } satisfies AuthError,
  unknownUser: (username: string): AuthError => ({ code: 'unknown_user', username }),
  ownerUnclaimed: { code: 'owner_unclaimed' } satisfies AuthError,
  rateLimited: { code: 'rate_limited' } satisfies AuthError,
  // CSRF (ADR-033 §2): a cookie-authenticated unsafe request whose Origin is not ours.
  crossOrigin: { code: 'forbidden_origin', hint: AUTH_MESSAGES.crossOrigin } satisfies AuthError,
  // Auth disabled: only a loopback Host (and Origin, if any) is answered — the DNS-rebinding / cross-site guard.
  nonLoopbackRequest: { code: 'forbidden_origin', hint: AUTH_MESSAGES.nonLoopbackRequest } satisfies AuthError,
  unknownOrigin: { code: 'forbidden_origin', hint: AUTH_MESSAGES.crossOriginUnknownOrigin } satisfies AuthError,
  // Bearer credential present but unusable: malformed, unknown, revoked, expired, or its owner can't log in.
  invalidToken: { code: 'invalid_token' } satisfies AuthError,
  insufficientScope: (scope: Scope) => ({ code: 'insufficient_scope', scope }) as const satisfies AuthError,
  // Token management is for a person at a browser, never for a bearer token.
  sessionRequired: { code: 'session_required' } satisfies AuthError,
  unknownToken: (id: string): AuthError => ({ code: 'unknown_token', id }),
  // No PUBLIC_URL and a non-loopback Host: the instance cannot name the resource it would describe.
  metadataUnavailable: {
    code: 'resource_metadata_unavailable',
    hint: AUTH_MESSAGES.prmNeedsOrigin,
  } satisfies AuthError,
};

export type ChallengeableError = Extract<
  AuthError,
  { code: 'unauthenticated' | 'invalid_token' | 'insufficient_scope' }
>;
