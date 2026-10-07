import { describe, expect, it } from 'vitest';
import { SESSION_ABSOLUTE_MAX_MS } from '../../../../src/models/auth.js';
import { escapeHtml } from '../../../../src/diplomat/http/authPages.js';
import {
  HEALTH_PATH,
  isPublicRoute,
  LOGIN_PATH,
  LOGOUT_PATH,
  PUBLIC_ROUTES,
  SETUP_PATH,
  UI_APP_CSS_PATH,
} from '../../../../src/diplomat/http/authPaths.js';
import {
  clearedSessionCookie,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionCookie,
} from '../../../../src/diplomat/http/cookies.js';
import {
  createAttemptLimiter,
  createRateLimiter,
  MAX_FAILURES_PER_IP,
  MAX_FAILURES_PER_USERNAME,
  LOGIN_ATTEMPT_WINDOW_MS,
} from '../../../../src/diplomat/http/rateLimiter.js';

describe('PUBLIC_ROUTES (ADR-033 §6)', () => {
  it('is exactly liveness, the two session-creating pages and their stylesheet', () => {
    expect(Object.keys(PUBLIC_ROUTES).sort()).toEqual([HEALTH_PATH, LOGIN_PATH, SETUP_PATH, UI_APP_CSS_PATH].sort());
  });

  it('never exposes logout, status, the API, MCP or the other UI assets', () => {
    for (const path of [
      LOGOUT_PATH,
      '/api/status',
      '/api/accounts',
      '/mcp',
      '/ui',
      '/ui/events',
      '/ui/assets/app.js',
    ]) {
      expect(isPublicRoute(path, 'GET')).toBe(false);
    }
  });

  it('is method-aware: only reads of health, and forms for login/setup', () => {
    expect(isPublicRoute(HEALTH_PATH, 'GET')).toBe(true);
    expect(isPublicRoute(HEALTH_PATH, 'HEAD')).toBe(true);
    expect(isPublicRoute(HEALTH_PATH, 'POST')).toBe(false);
    expect(isPublicRoute(LOGIN_PATH, 'POST')).toBe(true);
    expect(isPublicRoute(SETUP_PATH, 'post')).toBe(true);
    expect(isPublicRoute(LOGIN_PATH, 'DELETE')).toBe(false);
    expect(isPublicRoute(UI_APP_CSS_PATH, 'POST')).toBe(false);
  });

  it('treats a request no route matched as protected', () => {
    expect(isPublicRoute(undefined, 'GET')).toBe(false);
  });
});

describe('session cookie', () => {
  const ABSOLUTE_MAX_SECONDS = SESSION_ABSOLUTE_MAX_MS / 1000;

  it('is HttpOnly, SameSite=Lax, Path=/ and lives as long as a session possibly can', () => {
    expect(sessionCookie('abc_DEF-123', false)).toBe(
      `${SESSION_COOKIE_NAME}=abc_DEF-123; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ABSOLUTE_MAX_SECONDS}`,
    );
  });

  it('adds Secure only when asked', () => {
    expect(sessionCookie('t', true)).toMatch(/; Secure$/);
    expect(sessionCookie('t', false)).not.toContain('Secure');
  });

  it('is cleared with an empty value and Max-Age=0, with the same attributes so the browser matches it', () => {
    expect(clearedSessionCookie(false)).toBe(`${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect(clearedSessionCookie(true)).toContain('Secure');
  });
});

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie('a=1; fintrack_session=tok-en_1; b=2', 'fintrack_session')).toBe('tok-en_1');
  });

  it('is exact on the name — a prefix or suffix lookalike never matches', () => {
    expect(readCookie('xfintrack_session=evil; fintrack_session_x=evil', 'fintrack_session')).toBeUndefined();
  });

  it('returns undefined without a header or without the cookie', () => {
    expect(readCookie(undefined, 'fintrack_session')).toBeUndefined();
    expect(readCookie('a=1', 'fintrack_session')).toBeUndefined();
  });

  it('returns the first of a duplicated cookie and keeps "=" inside values intact', () => {
    expect(readCookie('s=first; s=second', 's')).toBe('first');
    expect(readCookie('s=a=b==', 's')).toBe('a=b==');
  });
});

describe('createRateLimiter', () => {
  const make = (now: { value: number }) => createRateLimiter({ windowMs: 1000, maxFailures: 3, now: () => now.value });

  it('limits a key after maxFailures within the window', () => {
    const clock = { value: 0 };
    const limiter = make(clock);
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    expect(limiter.isLimited('k')).toBe(false);
    limiter.recordFailure('k');
    expect(limiter.isLimited('k')).toBe(true);
    expect(limiter.isLimited('other')).toBe(false);
  });

  it('forgets failures once they leave the window', () => {
    const clock = { value: 0 };
    const limiter = make(clock);
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    clock.value = 1001;
    expect(limiter.isLimited('k')).toBe(false);
  });

  it('forgives only the most recent strike', () => {
    const clock = { value: 0 };
    const limiter = make(clock);
    [1, 2, 3].forEach(() => limiter.recordFailure('k'));
    expect(limiter.isLimited('k')).toBe(true);
    limiter.forgive('k');
    expect(limiter.isLimited('k')).toBe(false);
    limiter.forgive('never-seen');
  });

  it('resets a key', () => {
    const clock = { value: 0 };
    const limiter = make(clock);
    [1, 2, 3].forEach(() => limiter.recordFailure('k'));
    limiter.reset('k');
    expect(limiter.isLimited('k')).toBe(false);
  });

  it('bounds the number of tracked keys', () => {
    const clock = { value: 0 };
    const limiter = createRateLimiter({ windowMs: 1_000_000, maxFailures: 1, now: () => clock.value });
    for (let key = 0; key < 10_050; key += 1) limiter.recordFailure(`key-${key}`);
    expect(limiter.isLimited('key-0')).toBe(false); // evicted
    expect(limiter.isLimited('key-10049')).toBe(true);
  });
});

describe('createAttemptLimiter', () => {
  it('limits per username regardless of IP, and per IP regardless of username', () => {
    const clock = { value: 0 };
    const limiter = createAttemptLimiter(() => clock.value);
    for (let attempt = 0; attempt < MAX_FAILURES_PER_USERNAME; attempt += 1)
      limiter.recordFailure(`10.0.0.${attempt}`, 'rafael');
    expect(limiter.isLimited('10.9.9.9', 'rafael')).toBe(true);
    expect(limiter.isLimited('10.9.9.9', 'someone-else')).toBe(false);

    for (let attempt = 0; attempt < MAX_FAILURES_PER_IP; attempt += 1)
      limiter.recordFailure('192.168.0.1', `user-${attempt}`);
    expect(limiter.isLimited('192.168.0.1', 'fresh-name')).toBe(true);
  });

  it('clears a username on success but keeps counting the IP', () => {
    const clock = { value: 0 };
    const limiter = createAttemptLimiter(() => clock.value);
    for (let attempt = 0; attempt < MAX_FAILURES_PER_USERNAME; attempt += 1) limiter.recordFailure('1.1.1.1', 'rafael');
    limiter.recordSuccess('1.1.1.1', 'rafael');
    expect(limiter.isLimited('2.2.2.2', 'rafael')).toBe(false);
  });

  it('takes back the IP strike of a successful attempt, so reserving up front costs honest users nothing', () => {
    const clock = { value: 0 };
    const limiter = createAttemptLimiter(() => clock.value);
    for (let attempt = 0; attempt < MAX_FAILURES_PER_IP; attempt += 1) {
      limiter.recordFailure('1.1.1.1', `user-${attempt}`); // reserved before verification
      limiter.recordSuccess('1.1.1.1', `user-${attempt}`);
    }
    expect(limiter.isLimited('1.1.1.1', 'fresh')).toBe(false);
  });

  it('forgives an attempt that was not a failed guess', () => {
    const clock = { value: 0 };
    const limiter = createAttemptLimiter(() => clock.value);
    for (let attempt = 0; attempt < MAX_FAILURES_PER_USERNAME; attempt += 1) {
      limiter.recordFailure('1.1.1.1', 'rafael');
      limiter.forgive('1.1.1.1', 'rafael');
    }
    expect(limiter.isLimited('1.1.1.1', 'rafael')).toBe(false);
  });

  it('recovers after the window', () => {
    const clock = { value: 0 };
    const limiter = createAttemptLimiter(() => clock.value);
    for (let attempt = 0; attempt < MAX_FAILURES_PER_USERNAME; attempt += 1) limiter.recordFailure('1.1.1.1', 'rafael');
    clock.value = LOGIN_ATTEMPT_WINDOW_MS + 1;
    expect(limiter.isLimited('1.1.1.1', 'rafael')).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that could break out of text or an attribute', () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;',
    );
  });
});
