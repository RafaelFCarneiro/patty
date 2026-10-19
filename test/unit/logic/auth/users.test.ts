import { describe, expect, it } from 'vitest';
import {
  authorizeActor,
  claimedByInvite,
  disabledUser,
  enabledUser,
  loggedIn,
  formatInviteCode,
  guardAdminChange,
  inviteLink,
  isActiveAdmin,
  isInviteLive,
  isInviteUsable,
  newInvite,
  newInvitedUser,
  normalizeInviteCode,
  remainingAdmins,
  spentInvite,
  summarizeUser,
  userStatus,
  withCredentialsChanged,
  withoutPassword,
  withRole,
} from '../../../../src/logic/auth/users.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { type UserEntity, UserRole } from '../../../../src/models/auth/owner.js';
import { PrincipalVia, type Principal } from '../../../../src/models/auth/principal.js';
import { ALL_SCOPES } from '../../../../src/models/auth/scope.js';
import { HOUR_MS } from '../../../../src/models/auth/time.js';
import {
  INVITE_TTL_HOURS,
  INVITE_TTL_MS,
  UserStatus,
  type Actor,
  type InviteEntity,
} from '../../../../src/models/auth/users.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + INVITE_TTL_MS + 1);

const user = (id: string, overrides: Partial<UserEntity> = {}): UserEntity => ({
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
const admin = (id: string, overrides: Partial<UserEntity> = {}) =>
  user(id, { role: UserRole.enum.admin, ...overrides });
const invited = (id: string, overrides: Partial<UserEntity> = {}) => user(id, { passwordHash: null, ...overrides });

const invite = (overrides: Partial<InviteEntity> = {}): InviteEntity => ({
  id: 'invite-1',
  userId: 'ana',
  codeHash: 'hash',
  createdBy: 'root',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS).toISOString(),
  usedAt: null,
  version: 0,
  ...overrides,
});

const sessionPrincipal = (userId: string, via: PrincipalVia = PrincipalVia.enum.session): Principal => ({
  userId,
  role: UserRole.enum.admin,
  scopes: [...ALL_SCOPES],
  via,
});
const sessionActor = (userId: string, via?: PrincipalVia): Actor => ({
  kind: 'session',
  principal: sessionPrincipal(userId, via),
});
const TERMINAL: Actor = { kind: 'terminal' };

describe('invite lifetime', () => {
  it('lasts 72 hours', () => {
    expect(INVITE_TTL_HOURS).toBe(72);
    expect(INVITE_TTL_MS).toBe(72 * HOUR_MS);
  });

  it('expires 72 hours after it is issued, unused', () => {
    const issued = newInvite({ id: 'i', userId: 'ana', codeHash: 'h', createdBy: null }, NOW);
    expect(issued).toMatchObject({ createdBy: null, usedAt: null, createdAt: NOW.toISOString() });
    expect(Date.parse(issued.expiresAt) - NOW.getTime()).toBe(INVITE_TTL_MS);
  });

  it.each([
    ['unused and unexpired', invite(), NOW, true],
    ['already used', invite({ usedAt: NOW.toISOString() }), NOW, false],
    ['expired', invite(), LATER, false],
    ['expiring this very instant', invite(), new Date(NOW.getTime() + INVITE_TTL_MS), false],
  ])('treats an invite that is %s as usable: %s', (_label, subject, now, usable) => {
    expect(isInviteUsable(subject, now)).toBe(usable);
    expect(isInviteLive(subject, now)).toBe(usable);
  });

  it('treats no invite as unusable', () => {
    expect(isInviteUsable(null, NOW)).toBe(false);
  });

  it('is spent by stamping the claim time, nothing else', () => {
    expect(spentInvite(invite(), NOW)).toEqual({ ...invite(), usedAt: NOW.toISOString() });
  });
});

describe('invite codes and links', () => {
  it('reads a typed code the way a setup code is read: case, dashes, spaces and look-alikes never matter', () => {
    expect(normalizeInviteCode('jkmn-pqrs tvwx-abcd-efgh')).toBe('JKMNPQRSTVWXABCDEFGH');
    expect(normalizeInviteCode('oil0-0000')).toBe('01100000');
    expect(formatInviteCode('JKMNPQRSTVWXABCDEFGH')).toBe('JKMN-PQRS-TVWX-ABCD-EFGH');
  });

  it('builds the link from the origin and the code, encoded', () => {
    expect(inviteLink('https://fin.example.com', 'JKMN-PQRS')).toBe(
      'https://fin.example.com/ui/access/invite?code=JKMN-PQRS',
    );
    expect(inviteLink('http://127.0.0.1:51737', 'a b&c')).toBe(
      'http://127.0.0.1:51737/ui/access/invite?code=a%20b%26c',
    );
  });
});

describe('what a user is', () => {
  it.each([
    ['claimed and enabled', user('ana'), UserStatus.enum.active],
    ['never claimed', invited('ana'), UserStatus.enum.invited],
    ['claimed then disabled', user('ana', { disabledAt: NOW.toISOString() }), UserStatus.enum.disabled],
    ['invited then disabled', invited('ana', { disabledAt: NOW.toISOString() }), UserStatus.enum.disabled],
  ])('is %s → %s', (_label, subject, status) => {
    expect(userStatus(subject)).toBe(status);
  });

  it('counts as an active admin only if it administers AND can log in right now', () => {
    expect(isActiveAdmin(admin('root'))).toBe(true);
    expect(isActiveAdmin(user('ana'))).toBe(false);
    expect(isActiveAdmin(admin('root', { disabledAt: NOW.toISOString() }))).toBe(false);
    expect(isActiveAdmin(admin('root', { passwordHash: null }))).toBe(false);
    expect(isActiveAdmin(null)).toBe(false);
  });

  it('lists the other active admins, never the target and never one who cannot log in', () => {
    const everyone = [
      admin('root'),
      admin('two'),
      admin('gone', { disabledAt: NOW.toISOString() }),
      admin('unclaimed', { passwordHash: null }),
      user('ana'),
    ];
    expect(remainingAdmins(everyone, everyone[0]!).map((u) => u.id)).toEqual(['two']);
  });

  it('summarizes a user without any hash, with the live invite that is waiting', () => {
    const summary = summarizeUser(invited('ana', { createdAt: 'then' }), [invite(), invite({ userId: 'bob' })], NOW);
    expect(summary).toEqual({
      id: 'ana',
      username: 'ana',
      role: 'member',
      status: 'invited',
      createdAt: 'then',
      lastLoginAt: null,
      inviteExpiresAt: invite().expiresAt,
    });
    expect(JSON.stringify(summary)).not.toContain('hash');
  });

  it('shows no waiting invite once it has expired or been used', () => {
    expect(summarizeUser(invited('ana'), [invite()], LATER).inviteExpiresAt).toBeNull();
    expect(summarizeUser(invited('ana'), [invite({ usedAt: NOW.toISOString() })], NOW).inviteExpiresAt).toBeNull();
  });
});

describe('the rows an action produces', () => {
  it('creates the unclaimed row an invite will claim: a username and a role, no password, never disabled', () => {
    expect(newInvitedUser({ id: 'u1', username: 'ana', role: UserRole.enum.admin }, NOW)).toEqual({
      id: 'u1',
      username: 'ana',
      passwordHash: null,
      role: 'admin',
      createdAt: NOW.toISOString(),
      disabledAt: null,
      lastLoginAt: null,
      credentialsChangedAt: NOW.toISOString(),
    });
  });

  it('claims by UPDATING that row: the password is set and the first login is stamped', () => {
    const claimed = claimedByInvite(invited('ana'), 'new-hash', NOW);
    expect(claimed).toMatchObject({
      id: 'ana',
      username: 'ana',
      passwordHash: 'new-hash',
      lastLoginAt: NOW.toISOString(),
    });
  });

  it('disables, enables, re-roles and clears the password without touching anything else', () => {
    const base = user('ana');
    const changed = { credentialsChangedAt: NOW.toISOString() };
    expect(disabledUser(base, NOW)).toEqual({ ...base, ...changed, disabledAt: NOW.toISOString() });
    expect(enabledUser(disabledUser(base, NOW))).toEqual({ ...base, ...changed });
    expect(withRole(base, UserRole.enum.admin)).toEqual({ ...base, role: 'admin' });
    expect(withoutPassword(base, NOW)).toEqual({ ...base, ...changed, passwordHash: null });
  });

  it('stamps when the set of ways in changed: on a disable, a reset, a login — not on a role change', () => {
    const base = user('ana');
    expect(withCredentialsChanged(base, NOW).credentialsChangedAt).toBe(NOW.toISOString());
    expect(loggedIn(base, NOW)).toMatchObject({
      lastLoginAt: NOW.toISOString(),
      credentialsChangedAt: NOW.toISOString(),
    });
    expect(withRole(base, UserRole.enum.admin).credentialsChangedAt).toBeNull();
  });
});

describe('who may manage users', () => {
  it('is the trusted terminal, always', () => {
    expect(authorizeActor(TERMINAL, null)).toBeNull();
  });

  it('is a signed-in browser admin', () => {
    expect(authorizeActor(sessionActor('root'), admin('root'))).toBeNull();
  });

  it.each([
    ['a member', user('ana')],
    ['a disabled admin', admin('root', { disabledAt: NOW.toISOString() })],
    ['an admin with no password (reissued)', admin('root', { passwordHash: null })],
    ['someone who no longer exists', null],
  ])('refuses %s as "admin required"', (_label, acting) => {
    expect(authorizeActor(sessionActor('root'), acting)).toEqual(authErrors.adminRequired);
  });

  it.each([PrincipalVia.enum.token, PrincipalVia.enum.stdio, PrincipalVia.enum.owner])(
    'refuses an admin acting through %s: user management is session-only',
    (via) => {
      expect(authorizeActor(sessionActor('root', via), admin('root'))).toEqual(authErrors.sessionRequired);
    },
  );
});

describe('the guards on taking an admin away', () => {
  const root = admin('root');
  const two = admin('two');
  const ana = user('ana');
  const target = (id: string, everyone: UserEntity[]) => everyone.find((u) => u.id === id)!;

  type Case = [string, 'disable' | 'demote' | 'reissue', string | null, string, UserEntity[], string | null];
  const cases: Case[] = [
    ['an admin disabling themself', 'disable', 'root', 'root', [root, two], 'cannot_change_self'],
    ['an admin demoting themself', 'demote', 'root', 'root', [root, two], 'cannot_change_self'],
    ['an admin disabling themself, alone', 'disable', 'root', 'root', [root], 'cannot_change_self'],
    ['an admin disabling another admin', 'disable', 'root', 'two', [root, two], null],
    ['an admin demoting another admin', 'demote', 'root', 'two', [root, two], null],
    ['an admin disabling a member', 'disable', 'root', 'ana', [root, ana], null],
    ['the only admin being disabled by the terminal', 'disable', null, 'root', [root, ana], 'last_admin'],
    ['the only admin being demoted by the terminal', 'demote', null, 'root', [root, ana], 'last_admin'],
    ['the only admin being reissued', 'reissue', 'root', 'root', [root, ana], 'last_admin'],
    ['the only admin being reissued by the terminal', 'reissue', null, 'root', [root, ana], 'last_admin'],
    [
      'the last active admin when the other is disabled',
      'disable',
      null,
      'root',
      [root, admin('two', { disabledAt: NOW.toISOString() })],
      'last_admin',
    ],
    [
      'the last active admin when the other never claimed',
      'demote',
      null,
      'root',
      [root, admin('two', { passwordHash: null })],
      'last_admin',
    ],
    ['an admin reissuing themself with another admin standing', 'reissue', 'root', 'root', [root, two], null],
    ['the terminal disabling one of two admins', 'disable', null, 'root', [root, two], null],
    [
      'an unclaimed admin being disabled (not an active admin to lose)',
      'disable',
      'root',
      'new',
      [root, admin('new', { passwordHash: null })],
      null,
    ],
    ['a disabled admin being demoted', 'demote', 'root', 'old', [root, admin('old', { disabledAt: 'x' })], null],
  ];

  it.each(cases)('%s', (_label, change, actingUserId, targetId, everyone, expected) => {
    const verdict = guardAdminChange(change, { actingUserId, target: target(targetId, everyone), users: everyone });
    expect(verdict?.code ?? null).toBe(expected);
  });
});
