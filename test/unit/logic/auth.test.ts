import { describe, expect, it } from 'vitest';
import {
  canLogin,
  declaredOrigin,
  evaluateSession,
  formatSetupCode,
  hasCredentials,
  isSameOrigin,
  isSessionExpired,
  isSetupCodeUsable,
  isStale,
  isUnclaimed,
  isUnsafeMethod,
  newSession,
  normalizeSetupCode,
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  setupBanner,
  shouldIssueSetupCode,
  slidingExpiry,
  touched,
} from '../../../src/logic/auth.js';
import {
  AuthMode,
  OWNER_USER_ID,
  UserRole,
  type SessionEntity,
  type SetupCodeEntity,
  type UserEntity,
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
});
