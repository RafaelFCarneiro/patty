import { describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  canLogin,
  claimedOwner,
  claimRaceWinner,
  csrfVerdict,
  declaredOrigin,
  evaluateSession,
  formatSetupCode,
  hasCredentials,
  isLoopbackRequest,
  isSameOrigin,
  isSessionExpired,
  isSetupCodeUsable,
  isStale,
  isUnclaimed,
  isUnsafeMethod,
  newSession,
  normalizeSetupCode,
  planOwnerClaim,
  preSessionCsrfVerdict,
  setupBanner,
  shouldIssueSetupCode,
  slidingExpiry,
  spentSetupCode,
  touched,
  withPasswordHash,
} from '../../../src/logic/auth.js';
import {
  AuthMode,
  authErrors,
  SESSION_ABSOLUTE_MAX_MS,
  OWNER_USER_ID,
  TERMINAL_SETUP_HINT,
  UserRole,
  type SessionEntity,
  type SetupCodeEntity,
  type UserEntity,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from '../../../src/models/auth.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const later = (ms: number, from = NOW): Date => new Date(from.getTime() + ms);

const owner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: null,
  passwordHash: null,
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  version: 0,
  ...overrides,
});
const claimed = (overrides: Partial<UserEntity> = {}): UserEntity =>
  owner({ username: 'rafael', passwordHash: '$argon2id$x', ...overrides });

const session = (overrides: Partial<SessionEntity> = {}): SessionEntity => ({
  ...newSession({ id: 's1', userId: OWNER_USER_ID, tokenHash: 'h' }, NOW),
  version: 0,
  ...overrides,
});

const setupCode = (overrides: Partial<SetupCodeEntity> = {}): SetupCodeEntity => ({
  id: 'c1',
  codeHash: 'h',
  createdAt: NOW.toISOString(),
  expiresAt: later(60_000).toISOString(),
  usedAt: null,
  version: 0,
  ...overrides,
});

describe('setup code text', () => {
  it('groups raw characters in fours for reading off a log', () => {
    expect(formatSetupCode('ABCDEFGHJKMNPQRSTVWX')).toBe('ABCD-EFGH-JKMN-PQRS-TVWX');
  });

  it('normalizes what was typed: case, dashes, spaces, and the I/L/O lookalikes', () => {
    expect(normalizeSetupCode('abcd efgh-jkmn_pqrs tvwx')).toBe('ABCDEFGHJKMNPQRSTVWX');
    expect(normalizeSetupCode('O0Il1')).toBe('00111');
  });

  it('round-trips: what formatSetupCode printed normalizes back to the raw code', () => {
    const raw = '0123456789ABCDEFGHJK';
    expect(normalizeSetupCode(formatSetupCode(raw))).toBe(raw);
  });
});

describe('owner state', () => {
  it('needs both a username and a password hash to count as having credentials', () => {
    expect(hasCredentials(owner())).toBe(false);
    expect(hasCredentials(owner({ username: 'rafael' }))).toBe(false);
    expect(hasCredentials(owner({ passwordHash: 'h' }))).toBe(false);
    expect(hasCredentials(claimed())).toBe(true);
  });

  it('is unclaimed only for an existing owner without credentials', () => {
    expect(isUnclaimed(owner())).toBe(true);
    expect(isUnclaimed(claimed())).toBe(false);
    expect(isUnclaimed(null)).toBe(false);
  });

  it('issues a setup code only when auth is required AND the owner is unclaimed', () => {
    expect(shouldIssueSetupCode(AuthMode.enum.required, owner())).toBe(true);
    expect(shouldIssueSetupCode(AuthMode.enum.disabled, owner())).toBe(false);
    expect(shouldIssueSetupCode(AuthMode.enum.required, claimed())).toBe(false);
    expect(shouldIssueSetupCode(AuthMode.enum.required, null)).toBe(false);
  });
});

describe('isSetupCodeUsable', () => {
  it('accepts an unexpired, unused code', () => {
    expect(isSetupCodeUsable(setupCode(), NOW)).toBe(true);
  });

  it.each([
    ['a missing code', null],
    ['an expired code', setupCode({ expiresAt: NOW.toISOString() })],
    ['a used code', setupCode({ usedAt: NOW.toISOString() })],
  ])('rejects %s', (_label, code) => {
    expect(isSetupCodeUsable(code, NOW)).toBe(false);
  });
});

describe('canLogin', () => {
  it('requires a known, claimed, enabled user and a matching password', () => {
    expect(canLogin(claimed(), true)).toBe(true);
  });

  it.each([
    ['an unknown user', null, true],
    ['a wrong password', claimed(), false],
    ['the unclaimed owner', owner(), true],
    ['a disabled user', claimed({ disabledAt: NOW.toISOString() }), true],
  ])('refuses %s', (_label, user, passwordMatches) => {
    expect(canLogin(user, passwordMatches)).toBe(false);
  });
});

describe('sessions', () => {
  it('starts with an idle expiry one window ahead', () => {
    const fresh = newSession({ id: 's', userId: 'u', tokenHash: 'h' }, NOW);
    expect(fresh.createdAt).toBe(NOW.toISOString());
    expect(fresh.lastSeenAt).toBe(NOW.toISOString());
    expect(Date.parse(fresh.expiresAt) - NOW.getTime()).toBe(SESSION_IDLE_TTL_MS);
  });

  it('slides the expiry forward from the time of use', () => {
    const use = later(SESSION_IDLE_TTL_MS / 2);
    expect(Date.parse(slidingExpiry(NOW.toISOString(), use)) - use.getTime()).toBe(SESSION_IDLE_TTL_MS);
  });

  it('never slides past the absolute maximum', () => {
    const nearEnd = later(SESSION_ABSOLUTE_MAX_MS - 1000);
    expect(slidingExpiry(NOW.toISOString(), nearEnd)).toBe(later(SESSION_ABSOLUTE_MAX_MS).toISOString());
  });

  it('is expired once the idle expiry passes', () => {
    expect(isSessionExpired(session(), later(SESSION_IDLE_TTL_MS - 1))).toBe(false);
    expect(isSessionExpired(session(), later(SESSION_IDLE_TTL_MS))).toBe(true);
  });

  it('is expired at the absolute maximum even if the stored idle expiry is still ahead', () => {
    const stale = session({ expiresAt: later(SESSION_ABSOLUTE_MAX_MS * 2).toISOString() });
    expect(isSessionExpired(stale, later(SESSION_ABSOLUTE_MAX_MS))).toBe(true);
  });

  it('is stale (worth touching) only after the touch interval', () => {
    expect(isStale(session(), later(SESSION_TOUCH_INTERVAL_MS - 1))).toBe(false);
    expect(isStale(session(), later(SESSION_TOUCH_INTERVAL_MS))).toBe(true);
  });

  it('touches by moving last_seen_at and expires_at only', () => {
    const use = later(SESSION_TOUCH_INTERVAL_MS);
    const next = touched(session(), use);
    expect(next.lastSeenAt).toBe(use.toISOString());
    expect(next.createdAt).toBe(NOW.toISOString());
    expect(next.tokenHash).toBe('h');
    expect(Date.parse(next.expiresAt)).toBeGreaterThan(Date.parse(session().expiresAt));
  });

  describe('evaluateSession', () => {
    it('is valid without a touch while fresh', () => {
      expect(evaluateSession(session(), claimed(), later(1000))).toEqual({ kind: 'valid', touch: false });
    });

    it('is valid with a touch once stale', () => {
      expect(evaluateSession(session(), claimed(), later(SESSION_TOUCH_INTERVAL_MS))).toEqual({
        kind: 'valid',
        touch: true,
      });
    });

    it.each([
      ['an expired session', session(), claimed(), later(SESSION_IDLE_TTL_MS)],
      ['a missing user', session(), null, NOW],
      ['an unclaimed user', session(), owner(), NOW],
      ['a disabled user', session(), claimed({ disabledAt: NOW.toISOString() }), NOW],
    ])('is invalid for %s', (_label, candidate, user, now) => {
      expect(evaluateSession(candidate, user, now)).toEqual({ kind: 'invalid' });
    });
  });
});

describe('CSRF helpers', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('treats %s as unsafe', (method) => {
    expect(isUnsafeMethod(method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('treats %s as safe', (method) => {
    expect(isUnsafeMethod(method)).toBe(false);
  });

  it('reads the origin from Origin, else from the Referer', () => {
    expect(declaredOrigin('https://a.example', 'https://b.example/x')).toBe('https://a.example');
    expect(declaredOrigin(undefined, 'https://b.example/some/path?q=1')).toBe('https://b.example');
  });

  it('declares nothing for a missing, opaque or malformed origin', () => {
    expect(declaredOrigin(undefined, undefined)).toBeNull();
    expect(declaredOrigin('null', undefined)).toBeNull();
    expect(declaredOrigin('not a url', undefined)).toBeNull();
    expect(declaredOrigin(undefined, 'file:///etc/passwd')).toBeNull();
  });

  it('does not fall back to Referer when an Origin header is present', () => {
    expect(declaredOrigin('null', 'https://fintrack.example.com/ui')).toBeNull();
  });

  it('matches origins exactly — scheme, host and port', () => {
    const expected = 'https://fintrack.example.com';
    expect(isSameOrigin(expected, 'https://fintrack.example.com')).toBe(true);
    expect(isSameOrigin(expected, 'http://fintrack.example.com')).toBe(false);
    expect(isSameOrigin(expected, 'https://fintrack.example.com:8443')).toBe(false);
    expect(isSameOrigin(expected, 'https://fintrack.example.com.evil.example')).toBe(false);
    expect(isSameOrigin(expected, null)).toBe(false);
  });
});

describe('allowedOrigins (CSRF)', () => {
  const PUBLIC = 'https://fintrack.example.com';

  it('is PUBLIC_URL when it is set and the request came in on the public host', () => {
    expect(allowedOrigins(PUBLIC, 'fintrack.example.com')).toEqual([PUBLIC]);
  });

  it("also allows the request's own loopback origin (a local operator on the port publish)", () => {
    expect(allowedOrigins(PUBLIC, '127.0.0.1:51737')).toEqual([PUBLIC, 'http://127.0.0.1:51737']);
    expect(allowedOrigins(undefined, 'localhost:3001')).toEqual(['http://localhost:3001']);
    expect(allowedOrigins(undefined, '[::1]:3001')).toEqual(['http://[::1]:3001']);
  });

  it('never derives an origin from a non-loopback Host — a rebinding attacker controls it', () => {
    expect(allowedOrigins(undefined, 'attacker.example')).toEqual([]);
    expect(allowedOrigins(undefined, '192.168.1.10:51737')).toEqual([]);
    expect(allowedOrigins(PUBLIC, 'attacker.example')).toEqual([PUBLIC]);
  });

  it('is empty without a Host header or with a malformed one', () => {
    expect(allowedOrigins(undefined, undefined)).toEqual([]);
    expect(allowedOrigins(undefined, 'a b')).toEqual([]);
    expect(allowedOrigins(undefined, '127.0.0.1.evil.example')).toEqual([]);
  });
});

describe('csrfVerdict — a request that carries the session cookie', () => {
  const PUBLIC = 'https://fintrack.example.com';
  const request = (overrides: Partial<Parameters<typeof csrfVerdict>[0]> = {}) => ({
    method: 'POST',
    publicUrl: undefined as string | undefined,
    host: '127.0.0.1:51737',
    origin: undefined as string | undefined,
    referer: undefined as string | undefined,
    ...overrides,
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets a safe %s through whatever it declares', (method) => {
    expect(csrfVerdict(request({ method, origin: 'https://evil.example' }))).toBeNull();
    expect(csrfVerdict(request({ method, host: 'attacker.example' }))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('lets a same-origin %s through', (method) => {
    expect(csrfVerdict(request({ method, origin: 'http://127.0.0.1:51737' }))).toBeNull();
  });

  it('accepts the Referer when no Origin is sent', () => {
    expect(csrfVerdict(request({ referer: 'http://127.0.0.1:51737/ui/accounts' }))).toBeNull();
  });

  it('refuses an unsafe request that declares nothing', () => {
    expect(csrfVerdict(request())).toEqual(authErrors.crossOrigin);
  });

  it.each(['https://evil.example', 'http://127.0.0.1:9999', 'http://127.0.0.1:51737.evil.example', 'null'])(
    'refuses the cross-origin %j as crossOrigin',
    (origin) => {
      expect(csrfVerdict(request({ origin }))).toEqual(authErrors.crossOrigin);
    },
  );

  it('does not fall back to the Referer when an Origin header is present', () => {
    expect(csrfVerdict(request({ origin: 'https://evil.example', referer: 'http://127.0.0.1:51737/ui' }))).toEqual(
      authErrors.crossOrigin,
    );
  });

  it('answers unknownOrigin when the instance cannot name its own origin (non-loopback Host, no PUBLIC_URL)', () => {
    expect(csrfVerdict(request({ host: 'fintrack.lan:51737', origin: 'http://fintrack.lan:51737' }))).toEqual(
      authErrors.unknownOrigin,
    );
    expect(csrfVerdict(request({ host: undefined, origin: 'http://127.0.0.1:51737' }))).toEqual(
      authErrors.unknownOrigin,
    );
  });

  it('expects PUBLIC_URL when set — and still the loopback host it was reached on', () => {
    const behindProxy = { publicUrl: PUBLIC, host: 'fintrack.example.com' };
    expect(csrfVerdict(request({ ...behindProxy, origin: PUBLIC }))).toBeNull();
    expect(csrfVerdict(request({ ...behindProxy, origin: 'https://evil.example' }))).toEqual(authErrors.crossOrigin);
    expect(csrfVerdict(request({ publicUrl: PUBLIC, origin: 'http://127.0.0.1:51737' }))).toBeNull();
  });
});

describe('preSessionCsrfVerdict — login and setup POSTs', () => {
  const post = (origin?: string, referer?: string) => ({
    method: 'POST',
    publicUrl: undefined,
    host: '127.0.0.1:51737',
    origin,
    referer,
  });

  it('leaves a client that declares no origin alone (curl, scripts — no browser to defend)', () => {
    expect(preSessionCsrfVerdict(post())).toBeNull();
  });

  it('refuses a browser that declares a foreign origin or referer (forced login from a cross-site page)', () => {
    expect(preSessionCsrfVerdict(post('https://evil.example'))).toEqual(authErrors.crossOrigin);
    expect(preSessionCsrfVerdict(post(undefined, 'https://evil.example/login-form'))).toEqual(authErrors.crossOrigin);
  });

  it('accepts a declared origin that is ours', () => {
    expect(preSessionCsrfVerdict(post('http://127.0.0.1:51737'))).toBeNull();
  });

  it('never blocks a safe method', () => {
    expect(preSessionCsrfVerdict({ ...post('https://evil.example'), method: 'GET' })).toBeNull();
  });
});

describe('isLoopbackRequest — auth-disabled DNS-rebinding / cross-site guard', () => {
  it.each(['127.0.0.1:3001', '127.0.0.1', 'localhost:3001', 'LOCALHOST:51737', '[::1]:3001', '127.5.6.7:80'])(
    'answers a request whose Host is %s',
    (host) => {
      expect(isLoopbackRequest({ host, origin: undefined })).toBe(true);
    },
  );

  it.each([
    'attacker.example',
    'attacker.example:3001',
    '127.0.0.1.attacker.example',
    'localhost.attacker.example:3001',
    '192.168.1.10:3001',
    '0.0.0.0:3001',
    '[::]:3001',
    '[2001:db8::1]:3001',
  ])('refuses a request whose Host is %s (a rebound name or a non-loopback address)', (host) => {
    expect(isLoopbackRequest({ host, origin: undefined })).toBe(false);
  });

  it.each([
    undefined,
    '',
    'a b',
    'localhost:99999999',
    '127.0.0.1@attacker.example',
    'x@127.0.0.1',
    '127.0.0.1/x',
    '127.0.0.1?x',
    'localhost.', // a trailing-dot FQDN is refused: fail closed
    '://',
  ])(
    'refuses a missing or malformed Host (%j)',
    (host) => {
      expect(isLoopbackRequest({ host, origin: undefined })).toBe(false);
    },
  );

  it('does not require an Origin — native MCP clients, curl and stdio-adjacent tools send none', () => {
    expect(isLoopbackRequest({ host: '127.0.0.1:3001', origin: undefined })).toBe(true);
  });

  it.each([
    'http://localhost:6274', // MCP Inspector
    'http://127.0.0.1:3001',
    'https://localhost',
    'http://[::1]:3001',
    'http://127.0.0.2:8080',
  ])('accepts the loopback Origin %s, any port', (origin) => {
    expect(isLoopbackRequest({ host: '127.0.0.1:3001', origin })).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://evil.example:3001',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://192.168.1.10:3001',
    'null', // opaque origin: a sandboxed iframe, a data: URL, a redirect chain
    '',
    'not a url',
    'ftp://localhost',
    'file:///etc/passwd',
    'chrome-extension://abcdef',
  ])('refuses the Origin %j even with a loopback Host', (origin) => {
    expect(isLoopbackRequest({ host: '127.0.0.1:3001', origin })).toBe(false);
  });

  it('needs BOTH to pass: a loopback Origin does not rescue a rebound Host', () => {
    expect(isLoopbackRequest({ host: 'attacker.example', origin: 'http://localhost:6274' })).toBe(false);
  });
});

describe('setupBanner', () => {
  it('shows the code, where to use it and when it expires', () => {
    const banner = setupBanner({
      code: 'ABCD-EFGH-JKMN-PQRS-TVWX',
      setupUrl: 'http://127.0.0.1:51737/ui/setup',
      expiresAt: '2026-10-07T12:30:00.000Z',
    });
    expect(banner).toContain('ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(banner).toContain('http://127.0.0.1:51737/ui/setup');
    expect(banner).toContain('2026-10-07T12:30:00.000Z');
  });

  it('also names the terminal route, from the shared constant', () => {
    const banner = setupBanner({ code: 'ABCD', setupUrl: 'http://127.0.0.1:51737/ui/setup', expiresAt: 'later' });
    expect(banner).toContain(TERMINAL_SETUP_HINT);
    expect(TERMINAL_SETUP_HINT).toBe('or run `npx @rafaelfcarneiro/fintrack auth setup` in a terminal');
  });
});

describe('owner credential helpers', () => {
  const owner = {
    id: 'user-owner',
    username: null,
    passwordHash: null,
    role: 'admin',
    createdAt: '2026-10-07T12:00:00.000Z',
    disabledAt: null,
    version: 7,
  } as const;

  it('claimedOwner sets the login on the same row and keeps its version', () => {
    const claimed = claimedOwner(owner, { username: 'rafael', passwordHash: 'hash' });
    expect(claimed).toEqual({ ...owner, username: 'rafael', passwordHash: 'hash' });
    expect(hasCredentials(claimed)).toBe(true);
    expect(hasCredentials(owner)).toBe(false);
  });

  it('withPasswordHash replaces only the hash', () => {
    const claimed = claimedOwner(owner, { username: 'rafael', passwordHash: 'old' });
    expect(withPasswordHash(claimed, 'new')).toEqual({ ...claimed, passwordHash: 'new' });
  });

  it('spentSetupCode stamps usedAt and nothing else', () => {
    const code = {
      id: 'setup-code',
      codeHash: 'h',
      createdAt: 'c',
      expiresAt: 'e',
      usedAt: null,
      version: 2,
    };
    const now = new Date('2026-10-07T12:00:00.000Z');
    expect(spentSetupCode(code, now)).toEqual({ ...code, usedAt: now.toISOString() });
  });
});

describe('planOwnerClaim and claimRaceWinner', () => {
  it('claims only while nobody holds the login', () => {
    expect(planOwnerClaim(null)).toEqual({ kind: 'claim' });
    expect(planOwnerClaim({ username: 'rafael' })).toEqual({ kind: 'skip', username: 'rafael' });
  });

  it('names a winner only for a setup_unavailable refusal with a holder', () => {
    expect(claimRaceWinner(authErrors.setupUnavailable, { username: 'rafael' })).toEqual({ username: 'rafael' });
    expect(claimRaceWinner(authErrors.setupUnavailable, null)).toBeNull();
    expect(claimRaceWinner(authErrors.invalidCredentials, { username: 'rafael' })).toBeNull();
  });
});
