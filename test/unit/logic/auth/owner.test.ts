import { describe, expect, it } from 'vitest';
import {
  claimRaceWinner,
  claimedOwner,
  formatSetupCode,
  hasCredentials,
  isSetupCodeUsable,
  isUnclaimed,
  normalizeSetupCode,
  planOwnerClaim,
  shouldIssueSetupCode,
  spentSetupCode,
} from '../../../../src/logic/auth/owner.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { AuthMode } from '../../../../src/models/auth/mode.js';
import { OWNER_USER_ID, UserRole, type SetupCodeEntity, type UserEntity } from '../../../../src/models/auth/owner.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

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

const later = (ms: number, from = NOW): Date => new Date(from.getTime() + ms);

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
