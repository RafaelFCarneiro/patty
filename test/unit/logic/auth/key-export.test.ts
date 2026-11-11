import { describe, expect, it } from 'vitest';
import {
  findUserNamed,
  hasClaimedAdmin,
  isExportConfirmation,
  mayExportKey,
} from '../../../../src/logic/auth/key-export.js';
import { KEY_EXPORT_CONFIRMATION_ANSWER } from '../../../../src/models/auth/key-export.js';
import { adminFixture, unclaimedFixture, userFixture } from '../../fixtures/users.js';

describe('mayExportKey', () => {
  it('passes an active administrator with a login', () => {
    expect(mayExportKey(adminFixture('root'))).toBe(true);
  });

  it.each([
    ['a member', userFixture('ana')],
    ['a disabled administrator', adminFixture('root', { disabledAt: '2026-02-01T00:00:00.000Z' })],
    ['an administrator who never claimed their login', unclaimedFixture('root', { role: 'admin' })],
    ['no user at all', null],
  ])('refuses %s', (_label, user) => {
    expect(mayExportKey(user)).toBe(false);
  });
});

describe('hasClaimedAdmin', () => {
  it('is true when an administrator has a login', () => {
    expect(hasClaimedAdmin([userFixture('ana'), adminFixture('root')])).toBe(true);
  });

  it('is false while the owner is unclaimed and everyone else is a member', () => {
    expect(hasClaimedAdmin([unclaimedFixture('user-owner', { role: 'admin' }), userFixture('ana')])).toBe(false);
  });

  it('is false for no users', () => {
    expect(hasClaimedAdmin([])).toBe(false);
  });
});

describe('findUserNamed', () => {
  it('finds a user by their stored (normalized) username, or says there is none', () => {
    const users = [userFixture('ana'), adminFixture('root')];
    expect(findUserNamed(users, 'root')?.id).toBe('root');
    expect(findUserNamed(users, 'nobody')).toBeNull();
  });
});

describe('isExportConfirmation', () => {
  it('accepts only the confirming answer, ignoring case and surrounding space', () => {
    expect(isExportConfirmation(` ${KEY_EXPORT_CONFIRMATION_ANSWER.toUpperCase()} `)).toBe(true);
    expect(isExportConfirmation('y')).toBe(false);
    expect(isExportConfirmation('')).toBe(false);
    expect(isExportConfirmation('no')).toBe(false);
  });
});
