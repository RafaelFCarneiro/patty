import { describe, expect, it } from 'vitest';
import {
  evaluateSession,
  isSessionExpired,
  isStale,
  newSession,
  slidingExpiry,
  touched,
} from '../../../../src/logic/auth/session.js';
import { DAY_MS } from '../../../../src/models/auth/time.js';
import { OWNER_USER_ID, UserRole, type UserEntity } from '../../../../src/models/auth/owner.js';
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type SessionEntity,
} from '../../../../src/models/auth/session.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const later = (ms: number, from = NOW): Date => new Date(from.getTime() + ms);

const session = (overrides: Partial<SessionEntity> = {}): SessionEntity => ({
  ...newSession({ id: 's1', userId: OWNER_USER_ID, tokenHash: 'h' }, NOW),
  version: 0,
  ...overrides,
});

const owner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: null,
  passwordHash: null,
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: null,
  version: 0,
  ...overrides,
});

const claimed = (overrides: Partial<UserEntity> = {}): UserEntity =>
  owner({ username: 'rafael', passwordHash: '$argon2id$x', ...overrides });

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

  it('lets a session idle for 24 hours, and no longer', () => {
    expect(SESSION_IDLE_TTL_MS).toBe(DAY_MS);
    expect(isSessionExpired(session(), later(DAY_MS - 1))).toBe(false);
    expect(isSessionExpired(session(), later(DAY_MS))).toBe(true);
    expect(isSessionExpired(session(), later(DAY_MS + 1))).toBe(true);
  });

  it('slides a session seen within 24 hours a full window forward', () => {
    const seen = later(DAY_MS - SESSION_TOUCH_INTERVAL_MS);
    const next = touched(session(), seen);
    expect(Date.parse(next.expiresAt) - seen.getTime()).toBe(DAY_MS);
    expect(isSessionExpired(next, later(2 * DAY_MS - SESSION_TOUCH_INTERVAL_MS - 1))).toBe(false);
  });

  it('still ends at the absolute maximum for a session seen every day', () => {
    const visitGapMs = DAY_MS - 1;
    const visits = Math.ceil(SESSION_ABSOLUTE_MAX_MS / visitGapMs);
    const final = Array.from({ length: visits }, (_unused, visit) => later((visit + 1) * visitGapMs)).reduce(
      (current, seen) => {
        if (seen.getTime() >= later(SESSION_ABSOLUTE_MAX_MS).getTime()) return current;
        expect(isSessionExpired(current, seen)).toBe(false);
        return touched(current, seen);
      },
      session(),
    );
    expect(isSessionExpired(final, later(SESSION_ABSOLUTE_MAX_MS - 1))).toBe(false);
    expect(isSessionExpired(final, later(SESSION_ABSOLUTE_MAX_MS))).toBe(true);
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
