import { ok, err } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import { confirmKeyExportAdmin, guardClaimedAdminExists } from '../../../../src/controllers/auth/key-export.js';
import type { KeyExportDeps } from '../../../../src/controllers/deps.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { usersUnreadable } from '../../../../src/models/auth/key-export.js';
import type { UserEntity } from '../../../../src/models/auth/owner.js';
import { adminFixture, unclaimedFixture, userFixture } from '../../fixtures/users.js';

const RIGHT_PASSWORD = 'correct horse battery staple';
const DUMMY_HASH = 'dummy-hash';

/** A password check where a user's hash is "hash" and RIGHT_PASSWORD is theirs; counts every check it runs. */
const depsFor = (users: UserEntity[]) => {
  const verifyPassword = vi.fn(
    async (hash: string, password: string) => hash === 'hash' && password === RIGHT_PASSWORD,
  );
  const deps: KeyExportDeps = {
    users: async () => ok(users),
    secrets: { verifyPassword, dummyPasswordHash: DUMMY_HASH },
  };
  return { deps, verifyPassword };
};

describe('guardClaimedAdminExists', () => {
  it('passes when an administrator has a login', async () => {
    expect((await guardClaimedAdminExists(depsFor([adminFixture('root')]).deps)).isOk()).toBe(true);
  });

  it('refuses while no administrator has a login', async () => {
    const { deps } = depsFor([unclaimedFixture('user-owner', { role: 'admin' }), userFixture('ana')]);
    expect((await guardClaimedAdminExists(deps))._unsafeUnwrapErr()).toEqual(authErrors.ownerUnclaimed);
  });

  it('says why when the users cannot be read', async () => {
    const deps = { users: async () => err('no such table: users') };
    expect((await guardClaimedAdminExists(deps))._unsafeUnwrapErr()).toEqual(usersUnreadable('no such table: users'));
  });
});

describe('confirmKeyExportAdmin', () => {
  const users = [
    adminFixture('root'),
    userFixture('ana'),
    adminFixture('gone', { disabledAt: '2026-02-01T00:00:00.000Z' }),
    unclaimedFixture('invited', { role: 'admin' }),
  ];

  it('returns the administrator whose password it is', async () => {
    const { deps } = depsFor(users);
    const confirmed = await confirmKeyExportAdmin(deps, { username: 'root', password: RIGHT_PASSWORD });
    expect(confirmed._unsafeUnwrap().id).toBe('root');
  });

  it.each([
    ['a wrong password', { username: 'root', password: 'wrong password' }],
    ['an unknown user', { username: 'nobody', password: RIGHT_PASSWORD }],
    ['a member with the right password', { username: 'ana', password: RIGHT_PASSWORD }],
    ['a disabled administrator with the right password', { username: 'gone', password: RIGHT_PASSWORD }],
    ['an administrator who never claimed their login', { username: 'invited', password: RIGHT_PASSWORD }],
  ])('refuses %s with the one neutral refusal, after one full password check', async (_label, credentials) => {
    const { deps, verifyPassword } = depsFor(users);
    expect((await confirmKeyExportAdmin(deps, credentials))._unsafeUnwrapErr()).toEqual(authErrors.invalidCredentials);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('checks an unknown user against the dummy hash, so it costs what a wrong password costs', async () => {
    const { deps, verifyPassword } = depsFor(users);
    await confirmKeyExportAdmin(deps, { username: 'nobody', password: RIGHT_PASSWORD });
    expect(verifyPassword).toHaveBeenCalledWith(DUMMY_HASH, RIGHT_PASSWORD);
  });
});
