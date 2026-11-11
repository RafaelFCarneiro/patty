import { UserRole, type UserEntity } from '../../../src/models/auth/owner.js';

/** A claimed, active member; override what a test is about. */
export const userFixture = (id: string, overrides: Partial<UserEntity> = {}): UserEntity => ({
  id,
  username: id,
  passwordHash: 'hash',
  role: UserRole.enum.member,
  createdAt: '2026-01-01T00:00:00.000Z',
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: null,
  version: 0,
  ...overrides,
});

export const adminFixture = (id: string, overrides: Partial<UserEntity> = {}): UserEntity =>
  userFixture(id, { role: UserRole.enum.admin, ...overrides });

/** An invited or never-claimed user: no username, no password. */
export const unclaimedFixture = (id: string, overrides: Partial<UserEntity> = {}): UserEntity =>
  userFixture(id, { username: null, passwordHash: null, ...overrides });
