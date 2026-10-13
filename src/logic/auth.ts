import * as R from 'remeda';
import { HTTP_SCHEME_PREFIX, hostnameOfHostHeader, isLoopbackHost } from '../common/net.js';
import {
  BEARER_HEADER,
  BEARER_METHOD_HEADER,
  BEARER_SCHEME,
  DAY_MS,
  MAX_TOKEN_LENGTH,
  MCP_TOOLS_CALL_METHOD,
  NON_ALPHANUMERIC,
  OPAQUE_ORIGIN,
  READ_METHODS,
  RESOURCE_NAME,
  SAFE_METHODS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  SETUP_CODE_GROUP_SEPARATOR,
  SETUP_CODE_GROUP_SIZE,
  WEB_PROTOCOLS,
  AccessTokenKind,
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
  RedeemPlanKind,
  type Scope,
  SESSION_ABSOLUTE_MAX_MS,
  type SessionEntity,
  type SetupCodeEntity,
  TOKEN_ACCESS_SCOPES,
  TokenAccess,
  TOKEN_DISPLAY_PREFIX_RANDOM_CHARS,
  TOKEN_EXPIRY_DAYS,
  TERMINAL_SETUP_HINT,
  TOKEN_PREFIX,
  TokenStatus,
  WRITE_SCOPE,
  CLIENT_GRANT_TTL_MS,
  CONNECT_CODE_PARAM,
  CONNECT_PATH,
  DB_ID_LENGTH,
  DEFAULT_SIGN_IN_DURATION,
  GrantChannel,
  GrantStatus,
  MAX_SIGN_IN_DURATION_MS,
  SIGN_IN_ACCOUNT_PREFIX,
  SIGN_IN_DURATION_MS,
  SignInDuration,
  SESSION_ONLY_LABEL,
  STDIO_MESSAGES,
  UNKNOWN_CLIENT_NAME,
  TOKEN_NAME_MAX_LENGTH,
  type ClaimedOwner,
  type ClaimedUserEntity,
  type ClientGrantEntity,
  type GrantChoice,
  type GrantRequest,
  type StartGrantInput,
  type ChallengeableError,
  type ClaimPlan,
  type Credential,
  type CsrfRequest,
  type JsonRpcMessage,
  type SessionVerdict,
  type TokenFields,
  type TokenVerdict,
  type NewTokenSpec,
  type UserEntity,
} from '../models/auth.js';

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
export const hasCredentials = (user: UserEntity): user is ClaimedUserEntity =>
  user.username !== null && user.passwordHash !== null;

export const isUnclaimed = (owner: UserEntity | null): boolean => owner !== null && !hasCredentials(owner);

/** A setup code exists only while auth is on AND nobody holds the owner's credentials (ADR-033 §2). */
export const shouldIssueSetupCode = (mode: AuthMode, owner: UserEntity | null): boolean =>
  mode === AuthMode.enum.required && isUnclaimed(owner);

export const isSetupCodeUsable = (code: SetupCodeEntity | null, now: Date): code is SetupCodeEntity =>
  code !== null && code.usedAt === null && millis(code.expiresAt) > now.getTime();

export const claimedOwner = (owner: UserEntity, fields: { username: string; passwordHash: string }): UserEntity => ({
  ...owner,
  ...fields,
});

export const withPasswordHash = (user: UserEntity, passwordHash: string): UserEntity => ({ ...user, passwordHash });

export const spentSetupCode = (code: SetupCodeEntity, now: Date): SetupCodeEntity => ({
  ...code,
  usedAt: now.toISOString(),
});

export const planOwnerClaim = (claimed: ClaimedOwner | null): ClaimPlan =>
  claimed === null ? { kind: 'claim' } : { kind: 'skip', username: claimed.username };

/** A claim refused as `setup_unavailable` lost a race: whoever holds the login now (if anyone) is its winner. */
export const claimRaceWinner = (error: { code: string }, holder: ClaimedOwner | null): ClaimedOwner | null =>
  error.code === authErrors.setupUnavailable.code ? holder : null;

/** A user who holds credentials and has not been disabled — the only kind anything is minted for. */
export const isActiveUser = (user: UserEntity | null): user is ClaimedUserEntity =>
  user !== null && hasCredentials(user) && user.disabledAt === null;

/** Every way a login can fail is the same outcome — the caller cannot tell which. */
export const canLogin = (user: UserEntity | null, passwordMatches: boolean): user is UserEntity =>
  passwordMatches && isActiveUser(user);

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
    `│ Open ${fields.setupUrl} and enter the code, then choose a username and password,`,
    `│ ${TERMINAL_SETUP_HINT}.`,
    `│ The code expires at ${fields.expiresAt} and is replaced by a new one on every restart.`,
    '└──────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

// ─── Scopes ────────────────────────────────────────────────────────────────

/** `fintrack:write` implies `fintrack:read`; nothing else implies anything. */
export const hasScope = (granted: readonly string[], required: Scope): boolean =>
  granted.includes(required) || (required === READ_SCOPE && granted.includes(WRITE_SCOPE));

/** The default REST rule: reading methods need `read`, every other method needs `write`. Route definitions
 *  call this explicitly so each one's scope stays visible and reviewable (and a new method fails closed). */
export const defaultScopeForMethod = (method: string): Scope =>
  READ_METHODS.includes(method.toUpperCase()) ? READ_SCOPE : WRITE_SCOPE;

/** An MCP tool's scope comes from its `readOnlyHint` annotation — the single source. Anything not declared
 *  read-only needs `write`. */
export const scopeOfTool = (readOnlyHint: boolean | undefined): Scope =>
  readOnlyHint === true ? READ_SCOPE : WRITE_SCOPE;

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
    return typeof name !== 'string' || (toolScope(name) ?? WRITE_SCOPE) === WRITE_SCOPE;
  });
  return needsWrite ? WRITE_SCOPE : READ_SCOPE;
};

// ─── Bearer credentials (personal access tokens) ───────────────────────────

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
    kind: AccessTokenKind.enum.pat,
    clientName: null,
    profile: null,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    expiresAt: toIso(now.getTime() + days * DAY_MS),
    revokedAt: null,
  };
};

export const tokenStatus = (token: TokenFields, now: Date): TokenStatus =>
  token.revokedAt !== null
    ? TokenStatus.enum.revoked
    : token.expiresAt !== null && now.getTime() >= millis(token.expiresAt)
      ? TokenStatus.enum.expired
      : TokenStatus.enum.active;

/** Active: not revoked and not past its expiry. */
export const isLiveToken =
  (now: Date) =>
  (token: TokenFields): boolean =>
    tokenStatus(token, now) === TokenStatus.enum.active;

/** The token as the list shows it — never the hash. */
export const summarizeToken = (token: TokenFields, now: Date): AccessTokenSummary => ({
  id: token.id,
  userId: token.userId,
  name: token.name,
  prefix: token.prefix,
  scopes: token.scopes,
  kind: token.kind,
  clientName: token.clientName,
  profile: token.profile,
  createdAt: token.createdAt,
  lastUsedAt: token.lastUsedAt,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  status: tokenStatus(token, now),
});

/** A personal access token works on every surface; a stdio sign-in only where it was issued (the stdio session),
 *  so a copy lifted from the keychain is not also a key to `/api` and `/mcp` (ADR-034 §3). */
export const tokenAdmitsVia = (token: Pick<AccessTokenEntity, 'kind'>, via: PrincipalVia): boolean =>
  token.kind === AccessTokenKind.enum.pat || via === PrincipalVia.enum.stdio;

/** Unknown, revoked, expired, not meant for this surface, or belonging to an owner who is unclaimed/disabled →
 *  invalid. `last_used_at` is rewritten at most every `SESSION_TOUCH_INTERVAL_MS`, like a session's. */
export const evaluateToken = (
  token: AccessTokenEntity | null,
  user: UserEntity | null,
  now: Date,
  via: PrincipalVia = PrincipalVia.enum.token,
): TokenVerdict =>
  token === null ||
  !tokenAdmitsVia(token, via) ||
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

export const tokenPrincipal = (
  token: Pick<AccessTokenEntity, 'id' | 'scopes'>,
  user: UserEntity,
  via: PrincipalVia = PrincipalVia.enum.token,
): Principal => ({
  userId: user.id,
  role: user.role,
  scopes: token.scopes,
  via,
  tokenId: token.id,
});

// ─── Stdio sign-in (ADR-034) ───────────────────────────────────────────────

/** What a person typed vs. what was shown: a user code is normalized exactly like a setup code. */
export const normalizeUserCode = normalizeSetupCode;
/** `ABCDEFGH` → `ABCD-EFGH`. */
export const formatUserCode = formatSetupCode;

/** Absolute from approval, never from use, and never past the 30-day maximum. */
export const signInExpiry = (approvedAt: string, duration: SignInDuration): string =>
  toIso(millis(approvedAt) + Math.min(SIGN_IN_DURATION_MS[duration], MAX_SIGN_IN_DURATION_MS));

/** `session` lives in the stdio process's memory only; every other duration is saved to the keychain. */
export const persistsToKeychain = (duration: SignInDuration): boolean => duration !== SignInDuration.enum.session;

/** Whether this grant's asker may be handed a sign-in of this duration. */
export const durationAllowedFor = (channel: GrantChannel, duration: SignInDuration): boolean =>
  channel === GrantChannel.enum.stdio || duration !== SignInDuration.enum.session;

export const newGrant = (
  fields: { id: string; deviceCodeHash: string; userCode: string; input: StartGrantInput },
  now: Date,
): Omit<ClientGrantEntity, 'version'> => ({
  id: fields.id,
  deviceCodeHash: fields.deviceCodeHash,
  userCode: fields.userCode,
  clientName: fields.input.client.name,
  clientVersion: fields.input.client.version,
  profile: fields.input.profile,
  channel: fields.input.channel,
  hintAccess: fields.input.hint?.access ?? null,
  hintDuration: fields.input.hint?.duration ?? null,
  status: GrantStatus.enum.pending,
  userId: null,
  scopes: null,
  duration: null,
  createdAt: now.toISOString(),
  approvedAt: null,
  expiresAt: toIso(now.getTime() + CLIENT_GRANT_TTL_MS),
});

const isGrantExpired = (grant: ClientGrantEntity, now: Date): boolean => now.getTime() >= millis(grant.expiresAt);

/** A request still waiting for a person: pending and inside its window. */
export const isAnswerable = (grant: ClientGrantEntity | null, now: Date): grant is ClientGrantEntity =>
  grant !== null && grant.status === GrantStatus.enum.pending && !isGrantExpired(grant, now);

export const grantRequestOf = (grant: ClientGrantEntity): GrantRequest => ({
  userCode: formatUserCode(grant.userCode),
  clientName: grant.clientName,
  clientVersion: grant.clientVersion,
  profile: grant.profile,
  channel: grant.channel,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
});

export const approvedGrant = (
  grant: ClientGrantEntity,
  fields: { userId: string; scopes: readonly Scope[]; duration: SignInDuration },
  now: Date,
): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.approved,
  userId: fields.userId,
  scopes: [...fields.scopes],
  duration: fields.duration,
  approvedAt: now.toISOString(),
});

export const deniedGrant = (grant: ClientGrantEntity): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.denied,
});

export const redeemedGrant = (grant: ClientGrantEntity): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.redeemed,
});

export const expiredGrant = (grant: ClientGrantEntity): ClientGrantEntity => ({
  ...grant,
  status: GrantStatus.enum.expired,
});

/** What the consent form pre-selects: the asker's hint, else this user's last choice for this client, else the
 *  defaults (read-only, 24 hours). A hint of `session` is dropped for a grant that may not have one. */
export const consentChoice = (
  grant: ClientGrantEntity,
  last: Pick<ClientGrantEntity, 'scopes' | 'duration'> | null,
): GrantChoice => {
  const lastAccess = last?.scopes
    ? last.scopes.includes(WRITE_SCOPE)
      ? TokenAccess.enum.write
      : TokenAccess.enum.read
    : undefined;
  const duration = R.pipe(
    [grant.hintDuration, last?.duration],
    R.filter(
      (candidate): candidate is SignInDuration => candidate != null && durationAllowedFor(grant.channel, candidate),
    ),
    R.first(),
  );
  return {
    access: grant.hintAccess ?? lastAccess ?? TokenAccess.enum.read,
    duration: duration ?? DEFAULT_SIGN_IN_DURATION,
  };
};

/** What redeeming a device code means for this grant right now. `settle` is the expired row to write back, when
 *  the window has just run out on a grant that was still open. */
export type RedeemPlan =
  | { kind: typeof RedeemPlanKind.enum.invalid }
  | { kind: typeof RedeemPlanKind.enum.pending }
  | { kind: typeof RedeemPlanKind.enum.denied }
  | { kind: typeof RedeemPlanKind.enum.expired; settle: ClientGrantEntity | null }
  | {
      kind: typeof RedeemPlanKind.enum.mint;
      grant: ClientGrantEntity & { userId: string; scopes: Scope[]; duration: SignInDuration; approvedAt: string };
    };

export const redeemPlan = (grant: ClientGrantEntity | null, now: Date): RedeemPlan => {
  if (grant === null || grant.status === GrantStatus.enum.redeemed) return { kind: RedeemPlanKind.enum.invalid };
  if (grant.status === GrantStatus.enum.denied) return { kind: RedeemPlanKind.enum.denied };
  if (grant.status === GrantStatus.enum.expired) return { kind: RedeemPlanKind.enum.expired, settle: null };
  if (isGrantExpired(grant, now)) return { kind: RedeemPlanKind.enum.expired, settle: expiredGrant(grant) };
  if (grant.status === GrantStatus.enum.pending) return { kind: RedeemPlanKind.enum.pending };
  const { userId, scopes, duration, approvedAt } = grant;
  return userId !== null && scopes !== null && duration !== null && approvedAt !== null
    ? { kind: RedeemPlanKind.enum.mint, grant: { ...grant, userId, scopes, duration, approvedAt } }
    : { kind: RedeemPlanKind.enum.invalid };
};

/** The sign-in token a redeemed grant becomes. Its expiry is the approval time plus the chosen duration. */
export const newStdioSignIn = (
  fields: {
    id: string;
    tokenHash: string;
    prefix: string;
    grant: Extract<RedeemPlan, { kind: typeof RedeemPlanKind.enum.mint }>['grant'];
  },
  now: Date,
) => ({
  id: fields.id,
  userId: fields.grant.userId,
  kind: AccessTokenKind.enum.stdio,
  clientName: fields.grant.clientName,
  profile: fields.grant.profile,
  name: `${fields.grant.clientName} (${fields.grant.profile})`.slice(0, TOKEN_NAME_MAX_LENGTH),
  tokenHash: fields.tokenHash,
  prefix: fields.prefix,
  scopes: fields.grant.scopes,
  createdAt: now.toISOString(),
  lastUsedAt: null,
  expiresAt: signInExpiry(fields.grant.approvedAt, fields.grant.duration),
  revokedAt: null,
});

/** The keychain account of a saved sign-in. `dbId` is the first characters of sha256(absolute DB path), so a
 *  development database and a production one never share a saved sign-in. */
export const dbIdOf = (dbPathHash: string): string => dbPathHash.slice(0, DB_ID_LENGTH);
export const keychainAccount = (profile: string, dbId: string): string =>
  [SIGN_IN_ACCOUNT_PREFIX, profile, dbId].join(':');

/** `FINTRACK_TOKEN` must look like one of ours before it is even looked up. */
export const isTokenShaped = (raw: string): boolean => raw.startsWith(TOKEN_PREFIX) && raw.length <= MAX_TOKEN_LENGTH;

/**
 * The origin a stdio session's sign-in link may name from what it already knows, or `null`: `PUBLIC_URL`, else the
 * sidecar THIS process bound. Never a configured `HOST:PORT` it did not bind — whatever listens there may have opened a
 * different database, so a grant written here would never validate there — and, without `PUBLIC_URL`, never a
 * non-loopback host either: the page's cookie-authenticated POSTs trust only `PUBLIC_URL` or a loopback `Host` (CSRF).
 * `null` with HTTP enabled means "serve it yourself" (the session starts a temporary server of its own); with HTTP off
 * there is no page at all and the message says to use `login` or `FINTRACK_TOKEN`.
 */
export const signInOrigin = (fields: {
  httpEnabled: boolean;
  publicUrl: string | undefined;
  boundOrigin: string | null;
  host: string;
}): string | null => {
  if (!fields.httpEnabled) return null;
  if (fields.publicUrl !== undefined) return fields.publicUrl;
  return isLoopbackHost(fields.host) ? fields.boundOrigin : null;
};

/** What the consent form remembers a redeemed grant under: one slot per user, profile and client. */
const consentMemoryKey = (grant: ClientGrantEntity): string =>
  JSON.stringify([grant.userId, grant.profile, grant.clientName]);

const newestApproval = (grants: readonly ClientGrantEntity[]): ClientGrantEntity | undefined =>
  R.firstBy(grants, [(grant) => grant.approvedAt ?? '', 'desc'], [(grant) => grant.id, 'desc']);

/**
 * The redeemed grants that no longer matter: every one except the newest approval per user, profile and client — that
 * one is the consent form's "last choice" (`lastRedeemed` picks it by the same rule). Pending and approved grants are
 * not candidates at all; the caller only ever offers redeemed ones.
 */
export const supersededGrants = (redeemed: readonly ClientGrantEntity[]): ClientGrantEntity[] =>
  R.pipe(
    redeemed,
    R.groupBy(consentMemoryKey),
    R.values(),
    R.filter(R.isDefined),
    R.flatMap((group) => {
      const kept = newestApproval(group);
      return group.filter((grant) => grant.id !== kept?.id);
    }),
  );

/** The label of the "this session only" duration for the client that is asking: "This Claude Desktop session only". */
export const sessionOnlyLabel = (clientName: string): string =>
  clientName === UNKNOWN_CLIENT_NAME ? SESSION_ONLY_LABEL.unnamed : SESSION_ONLY_LABEL.named(clientName);

export const connectUrl = (origin: string, userCode: string): string =>
  `${origin}${CONNECT_PATH}?${CONNECT_CODE_PARAM}=${userCode}`;

/**
 * The text of the tool/resource/prompt error a signed-out stdio session answers with. The link carries the user
 * code only; nothing here — and nothing a caller can pass in — is a secret.
 */
export const notSignedInMessage = (fields: {
  /** The origin serving `/ui/connect`, or `null` when no HTTP server is involved (`FINTRACK_HTTP=false`). */
  origin: string | null;
  /** The code as displayed (`ABCD-EFGH`). */
  userCode: string | null;
  ownerUnclaimed: boolean;
}): string => {
  const base =
    fields.origin !== null && fields.userCode !== null
      ? STDIO_MESSAGES.notSignedIn(connectUrl(fields.origin, fields.userCode), fields.userCode)
      : STDIO_MESSAGES.notSignedInWithoutHttp;
  return fields.ownerUnclaimed ? `${base}${STDIO_MESSAGES.ownerUnclaimedHint}` : base;
};

// ─── Challenges (RFC 6750 §3, MCP authorization §"Error Handling") ──────────

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
