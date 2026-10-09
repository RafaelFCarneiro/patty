import { HTTP_SCHEME_PREFIX, hostnameOfHostHeader, isLoopbackHost } from '../common/net.js';
import {
  type AccessTokenEntity,
  type AccessTokenSummary,
  ALL_SCOPES,
  API_PATH_PREFIX,
  AuthMode,
  authErrors,
  type AuthError,
  MCP_PATH,
  MCP_PRM_PATH,
  type Principal,
  PrincipalVia,
  READ_SCOPE,
  type Scope,
  SESSION_ABSOLUTE_MAX_MS,
  type SessionEntity,
  type SetupCodeEntity,
  TOKEN_ACCESS_SCOPES,
  TOKEN_DISPLAY_PREFIX_RANDOM_CHARS,
  TOKEN_EXPIRY_DAYS,
  TOKEN_PREFIX,
  TokenStatus,
  WRITE_SCOPE,
  type NewTokenSpec,
  type UserEntity,
} from '../models/auth.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A session dies after this long without being seen (sliding)… */
export const SESSION_IDLE_TTL_MS = 7 * DAY_MS;
/** `last_seen_at`/`expires_at` are rewritten at most this often — not on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * MINUTE_MS;
export const SETUP_CODE_TTL_MS = 30 * MINUTE_MS;

const SETUP_CODE_GROUP_SIZE = 4;
const SETUP_CODE_GROUP_SEPARATOR = '-';
const NON_ALPHANUMERIC = /[^A-Za-z0-9]/g;

const READ_METHODS = ['GET', 'HEAD'];
const SAFE_METHODS: ReadonlySet<string> = new Set([...READ_METHODS, 'OPTIONS']);
const OPAQUE_ORIGIN = 'null';
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

const millis = (iso: string): number => Date.parse(iso);
const toIso = (millisSinceEpoch: number): string => new Date(millisSinceEpoch).toISOString();

// ─── Identity ──────────────────────────────────────────────────────────────

/** What a person typed vs. what was printed: case, dashes and spaces never matter. */
export const normalizeSetupCode = (raw: string): string =>
  raw
    .replace(NON_ALPHANUMERIC, '')
    .toUpperCase()
    // Crockford base32 has no I/L/O; people mistype them for 1/1/0.
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

/** `ABCDEFGHJKMNPQRSTVWX` → `ABCD-EFGH-JKMN-PQRS-TVWX`, for reading off a log line. */
export const formatSetupCode = (raw: string): string =>
  (raw.match(new RegExp(`.{1,${SETUP_CODE_GROUP_SIZE}}`, 'g')) ?? []).join(SETUP_CODE_GROUP_SEPARATOR);

/** The owner is "claimed" once it can log in; until then it is an owner row nobody can sign in as. */
export const hasCredentials = (user: UserEntity): boolean => user.username !== null && user.passwordHash !== null;

export const isUnclaimed = (owner: UserEntity | null): boolean => owner !== null && !hasCredentials(owner);

/** A setup code exists only while auth is on AND nobody holds the owner's credentials (ADR-033 §2). */
export const shouldIssueSetupCode = (mode: AuthMode, owner: UserEntity | null): boolean =>
  mode === AuthMode.enum.required && isUnclaimed(owner);

export const isSetupCodeUsable = (code: SetupCodeEntity | null, now: Date): code is SetupCodeEntity =>
  code !== null && code.usedAt === null && millis(code.expiresAt) > now.getTime();

/** Every way a login can fail is the same outcome — the caller cannot tell which. */
export const canLogin = (user: UserEntity | null, passwordMatches: boolean): user is UserEntity =>
  user !== null && passwordMatches && hasCredentials(user) && user.disabledAt === null;

// ─── Sessions ──────────────────────────────────────────────────────────────

/** Idle expiry, capped so a session can never outlive its absolute maximum. */
export const slidingExpiry = (createdAt: string, now: Date): string =>
  toIso(Math.min(now.getTime() + SESSION_IDLE_TTL_MS, millis(createdAt) + SESSION_ABSOLUTE_MAX_MS));

export const newSession = (fields: { id: string; userId: string; tokenHash: string }, now: Date) => ({
  ...fields,
  createdAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  expiresAt: slidingExpiry(now.toISOString(), now),
});

export const isSessionExpired = (session: SessionEntity, now: Date): boolean =>
  now.getTime() >= millis(session.expiresAt) || now.getTime() >= millis(session.createdAt) + SESSION_ABSOLUTE_MAX_MS;

export const isStale = (session: SessionEntity, now: Date): boolean =>
  now.getTime() - millis(session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS;

/** Slide the window forward — same row, later `last_seen_at`/`expires_at`. */
export const touched = (session: SessionEntity, now: Date): SessionEntity => ({
  ...session,
  lastSeenAt: now.toISOString(),
  expiresAt: slidingExpiry(session.createdAt, now),
});

/** A signed-in user acting through the browser: every scope (the session is the owner's own). */
export const sessionPrincipal = (user: UserEntity): Principal => ({
  userId: user.id,
  role: user.role,
  scopes: [...ALL_SCOPES],
  via: PrincipalVia.enum.session,
});

export type SessionVerdict = { kind: 'invalid' } | { kind: 'valid'; touch: boolean };

export const evaluateSession = (session: SessionEntity, user: UserEntity | null, now: Date): SessionVerdict =>
  isSessionExpired(session, now) || user === null || !hasCredentials(user) || user.disabledAt !== null
    ? { kind: 'invalid' }
    : { kind: 'valid', touch: isStale(session, now) };

// ─── CSRF ──────────────────────────────────────────────────────────────────

export const isUnsafeMethod = (method: string): boolean => !SAFE_METHODS.has(method.toUpperCase());

const parsedUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const originOf = (url: string): string | null => {
  const parsed = parsedUrl(url);
  // Opaque origins (`null`, data:, file:) never equal a real expected origin.
  return parsed === null || parsed.origin === OPAQUE_ORIGIN ? null : parsed.origin;
};

/** The browser-declared origin of a request: `Origin`, else the `Referer`'s origin, else unknown. */
export const declaredOrigin = (origin: string | undefined, referer: string | undefined): string | null =>
  origin !== undefined ? originOf(origin) : referer !== undefined ? originOf(referer) : null;

export const isSameOrigin = (expectedOrigin: string, declared: string | null): boolean =>
  declared !== null && declared === expectedOrigin;

/** Origins a browser may legitimately send for this request: `PUBLIC_URL`, plus — when the request itself
 *  arrived at a loopback host — that host's own origin (a local operator reaching a container through its
 *  loopback port publish). Never derived from a non-loopback `Host`, which a rebinding attacker controls. */
export const allowedOrigins = (publicUrl: string | undefined, hostHeader: string | undefined): string[] => {
  const hostname = hostHeader === undefined ? null : hostnameOfHostHeader(hostHeader);
  const ownLoopbackOrigin =
    hostHeader !== undefined && hostname !== null && isLoopbackHost(hostname)
      ? [`${HTTP_SCHEME_PREFIX}${hostHeader}`]
      : [];
  return [...(publicUrl === undefined ? [] : [publicUrl]), ...ownLoopbackOrigin];
};

/** Everything the same-origin (CSRF) decision reads from a request. */
export type CsrfRequest = {
  method: string;
  publicUrl: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
};

/**
 * The CSRF verdict for a request that carries ambient credentials (the session cookie): a safe method passes;
 * an unsafe one (`POST`/`PUT`/`PATCH`/`DELETE`, including `POST /mcp`) must declare — in `Origin`, else
 * `Referer` — an origin from `allowedOrigins`. `null` = allowed; otherwise the error to send (`unknownOrigin`
 * when this instance cannot say what its own origin is, `crossOrigin` when the declared one is not ours).
 */
export const csrfVerdict = (request: CsrfRequest): AuthError | null => {
  if (!isUnsafeMethod(request.method)) return null;
  const allowed = allowedOrigins(request.publicUrl, request.host);
  if (allowed.length === 0) return authErrors.unknownOrigin;
  const declared = declaredOrigin(request.origin, request.referer);
  return allowed.some((origin) => isSameOrigin(origin, declared)) ? null : authErrors.crossOrigin;
};

/**
 * The same check for the pre-session `POST`s (login, setup), which carry no cookie to forge but are still a
 * forced-login vector from a cross-site page: a browser that declares an origin must declare ours; a client
 * that declares none (`curl`, scripts) has no browser to defend.
 */
export const preSessionCsrfVerdict = (request: CsrfRequest): AuthError | null =>
  request.origin === undefined && request.referer === undefined ? null : csrfVerdict(request);

// ─── Auth disabled: loopback-only requests ─────────────────────────────────

// An `Origin` of http(s) on a loopback host, any port (MCP Inspector at http://localhost:6274 must keep working).
// An opaque (`null`), malformed or non-web origin is not loopback.
const isLoopbackOrigin = (origin: string): boolean => {
  const parsed = parsedUrl(origin);
  return (
    parsed !== null &&
    parsed.origin !== OPAQUE_ORIGIN &&
    WEB_PROTOCOLS.has(parsed.protocol) &&
    isLoopbackHost(parsed.hostname)
  );
};

/**
 * With auth disabled every request acts as the owner, so the only thing standing between a web page and the
 * user's finances is who the request says it is for. DNS rebinding sends `Host: attacker.example` to 127.0.0.1;
 * a cross-site `fetch`/form POST sends `Origin: https://evil.example`. Config guarantees disabled ⇒ loopback bind,
 * so every legitimate request names a loopback `Host`; a missing or malformed `Host` is refused, and an `Origin`
 * — which native MCP clients, curl and stdio-adjacent tools simply don't send — must be loopback if present.
 */
export const isLoopbackRequest = (request: { host: string | undefined; origin: string | undefined }): boolean => {
  const hostname = request.host === undefined ? null : hostnameOfHostHeader(request.host);
  if (hostname === null || !isLoopbackHost(hostname)) return false;
  return request.origin === undefined || isLoopbackOrigin(request.origin);
};

// ─── Operator messages ─────────────────────────────────────────────────────

export const setupBanner = (fields: { code: string; setupUrl: string; expiresAt: string }): string =>
  [
    '',
    '┌─ fintrack: first-time setup ─────────────────────────────────────────',
    '│ This instance has no login yet. Claim it with this one-time setup code:',
    '│',
    `│     ${fields.code}`,
    '│',
    `│ Open ${fields.setupUrl} and enter the code, then choose a username and password.`,
    `│ The code expires at ${fields.expiresAt} and is replaced by a new one on every restart.`,
    '└──────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

// ─── Scopes ────────────────────────────────────────────────────────────────

const MCP_TOOLS_CALL_METHOD = 'tools/call';

/** `fintrack:write` implies `fintrack:read`; nothing else implies anything. */
export const hasScope = (granted: readonly string[], required: Scope): boolean =>
  granted.includes(required) ||
  (required === READ_SCOPE && granted.includes(WRITE_SCOPE));

/** The default REST rule: reading methods need `read`, every other method needs `write`. Route definitions
 *  call this explicitly so each one's scope stays visible and reviewable (and a new method fails closed). */
export const defaultScopeForMethod = (method: string): Scope =>
  READ_METHODS.includes(method.toUpperCase()) ? READ_SCOPE : WRITE_SCOPE;

/** An MCP tool's scope comes from its `readOnlyHint` annotation — the single source. Anything not declared
 *  read-only needs `write`. */
export const scopeOfTool = (readOnlyHint: boolean | undefined): Scope =>
  readOnlyHint === true ? READ_SCOPE : WRITE_SCOPE;

type JsonRpcMessage = { method?: unknown; params?: { name?: unknown } | null };

/**
 * The scope a POST /mcp body needs: `write` if any message is a `tools/call` of a write tool (or of a tool
 * we cannot place — fail closed), else `read`. Other JSON-RPC methods (initialize, tools/list, resources/*,
 * prompts/*, ping, notifications) execute nothing that writes. Handles a batch (array) as well as one message.
 */
export const requiredMcpScope = (body: unknown, toolScope: (name: string) => Scope | undefined): Scope => {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  const needsWrite = messages.some((message) => {
    if (typeof message !== 'object' || message === null) return false;
    const { method, params } = message as JsonRpcMessage;
    if (method !== MCP_TOOLS_CALL_METHOD) return false;
    const name = params?.name;
    return (
      typeof name !== 'string' || (toolScope(name) ?? WRITE_SCOPE) === WRITE_SCOPE
    );
  });
  return needsWrite ? WRITE_SCOPE : READ_SCOPE;
};

// ─── Bearer credentials (personal access tokens) ───────────────────────────

const BEARER_SCHEME = 'Bearer';
const BEARER_HEADER = new RegExp(`^${BEARER_SCHEME}[ \\t]+(\\S+)$`, 'i');
const MAX_TOKEN_LENGTH = 256;

export type Credential = { kind: 'none' } | { kind: 'bearer'; token: string } | { kind: 'malformed' };

/** The `Authorization` header is authoritative when present: it must be `Bearer ftk_…`. Anything else
 *  (another scheme, no token, a token that is not ours) is `malformed` — never a reason to try the cookie. */
export const credentialOf = (authorization: string | undefined): Credential => {
  if (authorization === undefined) return { kind: 'none' };
  const token = BEARER_HEADER.exec(authorization)?.[1];
  return token !== undefined && token.startsWith(TOKEN_PREFIX) && token.length <= MAX_TOKEN_LENGTH
    ? { kind: 'bearer', token }
    : { kind: 'malformed' };
};

/** Only `/api` and `/mcp` take a bearer token; `/ui` is the browser surface and stays session-only. */
export const acceptsBearer = (path: string): boolean =>
  [API_PATH_PREFIX, MCP_PATH].some((root) => path === root || path.startsWith(`${root}/`));

/** `ftk_` + the first characters of the random part — enough to recognise a token in a list, not to use it. */
export const tokenDisplayPrefix = (token: string): string =>
  token.slice(0, TOKEN_PREFIX.length + TOKEN_DISPLAY_PREFIX_RANDOM_CHARS);

export const newAccessToken = (
  fields: { id: string; userId: string; tokenHash: string; prefix: string; input: NewTokenSpec },
  now: Date,
) => {
  const days = TOKEN_EXPIRY_DAYS[fields.input.expiry];
  return {
    id: fields.id,
    userId: fields.userId,
    name: fields.input.name,
    tokenHash: fields.tokenHash,
    prefix: fields.prefix,
    scopes: [...TOKEN_ACCESS_SCOPES[fields.input.access]],
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt: days === null ? null : toIso(now.getTime() + days * DAY_MS),
    revokedAt: null,
  };
};

/** A token's fields before it has been written (no `version` yet). */
type TokenFields = Omit<AccessTokenEntity, 'version'>;

export const tokenStatus = (token: TokenFields, now: Date): TokenStatus =>
  token.revokedAt !== null
    ? TokenStatus.enum.revoked
    : token.expiresAt !== null && now.getTime() >= millis(token.expiresAt)
      ? TokenStatus.enum.expired
      : TokenStatus.enum.active;

/** The token as the list shows it — never the hash. */
export const summarizeToken = (token: TokenFields, now: Date): AccessTokenSummary => ({
  id: token.id,
  userId: token.userId,
  name: token.name,
  prefix: token.prefix,
  scopes: token.scopes,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  status: tokenStatus(token, now),
});

export type TokenVerdict = { kind: 'invalid' } | { kind: 'valid'; touch: boolean };

/** Unknown, revoked, expired, or belonging to an owner who is unclaimed/disabled → invalid. `last_used_at` is
 *  rewritten at most every `SESSION_TOUCH_INTERVAL_MS`, like a session's. */
export const evaluateToken = (token: AccessTokenEntity | null, user: UserEntity | null, now: Date): TokenVerdict =>
  token === null ||
  tokenStatus(token, now) !== TokenStatus.enum.active ||
  user === null ||
  !hasCredentials(user) ||
  user.disabledAt !== null
    ? { kind: 'invalid' }
    : {
        kind: 'valid',
        touch: token.lastUsedAt === null || now.getTime() - millis(token.lastUsedAt) >= SESSION_TOUCH_INTERVAL_MS,
      };

export const usedToken = (token: AccessTokenEntity, now: Date): AccessTokenEntity => ({
  ...token,
  lastUsedAt: now.toISOString(),
});

export const revokedToken = (token: AccessTokenEntity, now: Date): AccessTokenEntity => ({
  ...token,
  revokedAt: now.toISOString(),
});

export const tokenPrincipal = (token: AccessTokenEntity, user: UserEntity): Principal => ({
  userId: user.id,
  role: user.role,
  scopes: token.scopes,
  via: PrincipalVia.enum.token,
  tokenId: token.id,
});

// ─── Challenges (RFC 6750 §3, MCP authorization §"Error Handling") ──────────

export type ChallengeableError = Extract<
  AuthError,
  { code: 'unauthenticated' | 'invalid_token' | 'insufficient_scope' }
>;

const quoted = (value: string): string => `"${value.replace(/["\\]/g, '\\$&')}"`;
const param = (name: string, value: string): string => `${name}=${quoted(value)}`;
const joinScopes = (scopes: readonly Scope[]): string => scopes.join(' ');

/** The origin the resource is served from: `PUBLIC_URL`, else the request's own loopback origin; `null` when
 *  the instance cannot say (non-loopback host, no `PUBLIC_URL`). */
export const resourceOrigin = (publicUrl: string | undefined, host: string | undefined): string | null =>
  allowedOrigins(publicUrl, host)[0] ?? null;

export const resourceMetadataUrl = (origin: string): string => `${origin}${MCP_PRM_PATH}`;

/**
 * The one place a `WWW-Authenticate` value is built.
 *   - no credential        → `resource_metadata` + every scope (what a client should request);
 *   - invalid/expired token → `error="invalid_token"` + `resource_metadata`;
 *   - too little scope      → `error="insufficient_scope"` + the scope that was needed + `resource_metadata`.
 * `resource_metadata` is left out when the instance cannot name its own origin.
 */
export const bearerChallenge = (error: ChallengeableError, metadataUrl: string | null): string => {
  const metadata = metadataUrl === null ? [] : [param('resource_metadata', metadataUrl)];
  switch (error.code) {
    case 'unauthenticated':
      return `${BEARER_SCHEME} ${[...metadata, param('scope', joinScopes(ALL_SCOPES))].join(', ')}`;
    case 'invalid_token':
      return `${BEARER_SCHEME} ${[param('error', error.code), ...metadata].join(', ')}`;
    case 'insufficient_scope':
      return `${BEARER_SCHEME} ${[param('error', error.code), param('scope', error.scope), ...metadata].join(', ')}`;
    default: {
      const _exhaustive: never = error;
      throw new Error(`unmapped challenge: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

// ─── Protected Resource Metadata (RFC 9728) ────────────────────────────────

const RESOURCE_NAME = 'FinTrack';
const BEARER_METHOD_HEADER = 'header';

/**
 * The metadata document for resource `<origin>/mcp`. `authorization_servers` is OPTIONAL in RFC 9728 and is
 * omitted until the in-process authorization server exists (ADR-033 Phase 3); `offline_access` is never listed
 * (MCP authorization: refresh tokens are not a resource requirement).
 */
export const protectedResourceMetadata = (origin: string) => ({
  resource: `${origin}${MCP_PATH}`,
  scopes_supported: [...ALL_SCOPES],
  bearer_methods_supported: [BEARER_METHOD_HEADER],
  resource_name: RESOURCE_NAME,
});
