import { describe, expect, it } from 'vitest';
import { isActiveUser } from '../../../../src/logic/auth/owner.js';
import {
  evaluateToken,
  isLiveToken,
  isTokenShaped,
  newAccessToken,
  revokedToken,
  summarizeToken,
  tokenAdmitsVia,
  tokenDisplayPrefix,
  tokenPrincipal,
  tokenStatus,
  usedToken,
} from '../../../../src/logic/auth/token.js';
import { OWNER_USER_ID, UserRole, type UserEntity } from '../../../../src/models/auth/owner.js';
import { PrincipalVia } from '../../../../src/models/auth/principal.js';
import { Scope } from '../../../../src/models/auth/scope.js';
import { SESSION_TOUCH_INTERVAL_MS } from '../../../../src/models/auth/session.js';
import { AccessTokenKind, TokenStatus, type AccessTokenEntity } from '../../../../src/models/auth/token.js';

const READ = Scope.enum['fintrack:read'];

const NOW = new Date('2026-10-09T12:00:00.000Z');

const WRITE = Scope.enum['fintrack:write'];

const DAY_MS = 24 * 60 * 60 * 1000;

const token = (overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id: 't1',
  userId: OWNER_USER_ID,
  kind: AccessTokenKind.enum.pat,
  clientName: null,
  profile: null,
  name: 'laptop',
  tokenHash: 'sha(ftk_x)',
  prefix: 'ftk_abcdef',
  scopes: [READ],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  version: 0,
  ...overrides,
});

const owner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: 'rafael',
  passwordHash: 'hash',
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: null,
  version: 1,
  ...overrides,
});

const HOUR_MS = 60 * 60 * 1000;

describe('new tokens', () => {
  const fields = { id: 't1', userId: OWNER_USER_ID, tokenHash: 'h', prefix: 'ftk_abcdef' };

  it('keeps only ftk_ + the first characters of the random part for display', () => {
    expect(tokenDisplayPrefix('ftk_abcdefghijklmnop')).toBe('ftk_abcdef');
  });

  it('read access is the read scope; write access includes read', () => {
    expect(newAccessToken({ ...fields, input: { name: 'n', access: 'read', expiry: '90' } }, NOW).scopes).toEqual([
      READ,
    ]);
    expect(newAccessToken({ ...fields, input: { name: 'n', access: 'write', expiry: '90' } }, NOW).scopes).toEqual([
      READ,
      WRITE,
    ]);
  });

  it.each([
    ['30', 30],
    ['90', 90],
    ['365', 365],
  ] as const)('expiry %s', (expiry, days) => {
    const created = newAccessToken({ ...fields, input: { name: 'n', access: 'read', expiry } }, NOW);
    expect(created.expiresAt).toBe(new Date(NOW.getTime() + days * DAY_MS).toISOString());
    expect(created).toMatchObject({ lastUsedAt: null, revokedAt: null, createdAt: NOW.toISOString() });
  });
});

describe('isLiveToken', () => {
  it('is true only for a token that is neither revoked nor past its expiry (a legacy null expiry counts)', () => {
    const live = isLiveToken(NOW);
    expect(live(token())).toBe(true);
    expect(live(token({ expiresAt: new Date(NOW.getTime() + 1).toISOString() }))).toBe(true);
    expect(live(token({ expiresAt: NOW.toISOString() }))).toBe(false);
    expect(live(token({ revokedAt: NOW.toISOString() }))).toBe(false);
  });
});

describe('tokenStatus and summarizeToken', () => {
  it('is active until revoked or expired; revoked wins', () => {
    expect(tokenStatus(token(), NOW)).toBe(TokenStatus.enum.active);
    expect(tokenStatus(token({ expiresAt: new Date(NOW.getTime() + 1).toISOString() }), NOW)).toBe('active');
    expect(tokenStatus(token({ expiresAt: NOW.toISOString() }), NOW)).toBe(TokenStatus.enum.expired);
    expect(tokenStatus(token({ revokedAt: NOW.toISOString() }), NOW)).toBe(TokenStatus.enum.revoked);
    expect(tokenStatus(token({ revokedAt: NOW.toISOString(), expiresAt: NOW.toISOString() }), NOW)).toBe('revoked');
  });

  it('never carries the hash or the version', () => {
    const summary = summarizeToken(token(), NOW);
    expect(summary).not.toHaveProperty('tokenHash');
    expect(summary).not.toHaveProperty('version');
    expect(JSON.stringify(summary)).not.toContain('sha(');
    expect(summary).toMatchObject({ id: 't1', name: 'laptop', prefix: 'ftk_abcdef', status: 'active' });
  });
});

describe('evaluateToken — the verdict', () => {
  it('is valid for an active token of a claimed, enabled owner', () => {
    expect(evaluateToken(token(), owner(), NOW)).toEqual({ kind: 'valid', touch: true });
  });

  it.each([
    ['unknown', null, owner()],
    ['revoked', token({ revokedAt: NOW.toISOString() }), owner()],
    ['expired', token({ expiresAt: NOW.toISOString() }), owner()],
    ['owner missing', token(), null],
    ['owner unclaimed', token(), owner({ username: null, passwordHash: null })],
    ['owner disabled', token(), owner({ disabledAt: NOW.toISOString() })],
  ])('is invalid when %s', (_label, entity, user) => {
    expect(evaluateToken(entity, user, NOW)).toEqual({ kind: 'invalid' });
  });

  it('touches last_used_at only when it is stale, with the session interval', () => {
    const used = token({ lastUsedAt: NOW.toISOString() });
    const justBefore = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS - 1);
    const atInterval = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS);
    expect(evaluateToken(used, owner(), NOW)).toEqual({ kind: 'valid', touch: false });
    expect(evaluateToken(used, owner(), justBefore)).toEqual({ kind: 'valid', touch: false });
    expect(evaluateToken(used, owner(), atInterval)).toEqual({ kind: 'valid', touch: true });
  });

  it('builds the principal from the token, not the user', () => {
    expect(tokenPrincipal(token({ scopes: [READ] }), owner())).toEqual({
      userId: OWNER_USER_ID,
      role: UserRole.enum.admin,
      scopes: [READ],
      via: PrincipalVia.enum.token,
      tokenId: 't1',
    });
  });

  it('marks use and revocation without touching anything else', () => {
    expect(usedToken(token(), NOW)).toEqual({ ...token(), lastUsedAt: NOW.toISOString() });
    expect(revokedToken(token(), NOW)).toEqual({ ...token(), revokedAt: NOW.toISOString() });
  });
});

describe('who a token may act for', () => {
  const stdioToken = (overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
    id: 't1',
    userId: 'user-owner',
    kind: AccessTokenKind.enum.stdio,
    clientName: 'Claude Desktop',
    profile: 'default',
    name: 'Claude Desktop (default)',
    tokenHash: 'sha(x)',
    prefix: 'ftk_abcdef',
    scopes: [READ],
    createdAt: NOW.toISOString(),
    lastUsedAt: null,
    expiresAt: new Date(NOW.getTime() + HOUR_MS).toISOString(),
    revokedAt: null,
    version: 0,
    ...overrides,
  });

  it('admits a stdio sign-in only on the stdio channel, and a personal access token everywhere', () => {
    expect(tokenAdmitsVia(stdioToken(), PrincipalVia.enum.stdio)).toBe(true);
    expect(tokenAdmitsVia(stdioToken(), PrincipalVia.enum.token)).toBe(false);
    expect(tokenAdmitsVia(stdioToken({ kind: AccessTokenKind.enum.pat }), PrincipalVia.enum.token)).toBe(true);
    expect(tokenAdmitsVia(stdioToken({ kind: AccessTokenKind.enum.pat }), PrincipalVia.enum.stdio)).toBe(true);
  });

  it('judges a stdio sign-in valid on stdio and invalid when presented over HTTP', () => {
    expect(evaluateToken(stdioToken(), owner(), NOW, PrincipalVia.enum.stdio).kind).toBe('valid');
    expect(evaluateToken(stdioToken(), owner(), NOW).kind).toBe('invalid');
  });

  it('turns an expired or revoked sign-in invalid on the next look', () => {
    const later = new Date(NOW.getTime() + 2 * HOUR_MS);
    expect(evaluateToken(stdioToken(), owner(), later, PrincipalVia.enum.stdio).kind).toBe('invalid');
    expect(
      evaluateToken(stdioToken({ revokedAt: NOW.toISOString() }), owner(), NOW, PrincipalVia.enum.stdio).kind,
    ).toBe('invalid');
  });

  it('acts as the channel it arrived on, with the token’s own scopes', () => {
    expect(tokenPrincipal(stdioToken(), owner(), PrincipalVia.enum.stdio)).toEqual({
      userId: 'user-owner',
      role: UserRole.enum.admin,
      scopes: [READ],
      via: 'stdio',
      tokenId: 't1',
    });
    expect(tokenPrincipal(stdioToken({ kind: AccessTokenKind.enum.pat }), owner()).via).toBe('token');
  });

  it('lists the client and profile of a sign-in, never its hash', () => {
    const summary = summarizeToken(stdioToken(), NOW);
    expect(summary).toMatchObject({
      kind: 'stdio',
      clientName: 'Claude Desktop',
      profile: 'default',
      status: 'active',
    });
    expect(summary).not.toHaveProperty('tokenHash');
  });

  it('only mints for a user who holds credentials and is not disabled', () => {
    expect(isActiveUser(owner())).toBe(true);
    expect(isActiveUser(owner({ passwordHash: null }))).toBe(false);
    expect(isActiveUser(owner({ disabledAt: NOW.toISOString() }))).toBe(false);
    expect(isActiveUser(null)).toBe(false);
  });
});

describe('token shape', () => {
  it('recognizes an ftk_ token of sane length and nothing else', () => {
    expect(isTokenShaped('ftk_abcdef')).toBe(true);
    expect(isTokenShaped('Bearer ftk_abc')).toBe(false);
    expect(isTokenShaped('sk-secret')).toBe(false);
    expect(isTokenShaped(`ftk_${'a'.repeat(300)}`)).toBe(false);
  });
});
