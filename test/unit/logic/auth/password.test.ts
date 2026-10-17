import { describe, expect, it } from 'vitest';
import { claimedOwner } from '../../../../src/logic/auth/owner.js';
import { canLogin, withPasswordHash } from '../../../../src/logic/auth/password.js';
import { OWNER_USER_ID, UserRole, type UserEntity } from '../../../../src/models/auth/owner.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const owner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: null,
  passwordHash: null,
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  version: 0,
  ...overrides,
});

const claimed = (overrides: Partial<UserEntity> = {}): UserEntity =>
  owner({ username: 'rafael', passwordHash: '$argon2id$x', ...overrides });

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

describe('withPasswordHash', () => {
  const owner = {
    id: 'user-owner',
    username: null,
    passwordHash: null,
    role: 'admin',
    createdAt: '2026-10-07T12:00:00.000Z',
    disabledAt: null,
    lastLoginAt: null,
    version: 7,
  } as const;

  it('withPasswordHash replaces only the hash', () => {
    const claimed = claimedOwner(owner, { username: 'rafael', passwordHash: 'old' });
    expect(withPasswordHash(claimed, 'new')).toEqual({ ...claimed, passwordHash: 'new' });
  });
});
