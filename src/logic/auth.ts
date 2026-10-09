import { hostnameOfHostHeader, isLoopbackHost } from '../common/net.js';
import {
  AuthMode,
  SESSION_ABSOLUTE_MAX_MS,
  type SessionEntity,
  type SetupCodeEntity,
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

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
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
