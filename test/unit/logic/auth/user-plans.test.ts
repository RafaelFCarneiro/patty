import { describe, expect, it } from 'vitest';
import { planDisable, planReissue, planRole } from '../../../../src/logic/auth/user-plans.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { type UserEntity, UserRole } from '../../../../src/models/auth/owner.js';
import type { SessionEntity } from '../../../../src/models/auth/session.js';
import { type AccessTokenEntity, AccessTokenKind } from '../../../../src/models/auth/token.js';
import { GrantStatus, type ClientGrantEntity } from '../../../../src/models/auth/grant.js';
import { INVITE_TTL_MS, type InviteEntity } from '../../../../src/models/auth/users.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const FUTURE = '2026-12-01T00:00:00.000Z';

const user = (id: string, overrides: Partial<UserEntity> = {}): UserEntity => ({
  id,
  username: id,
  passwordHash: 'hash',
  role: UserRole.enum.member,
  createdAt: '2026-01-01T00:00:00.000Z',
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: null,
  version: 1,
  ...overrides,
});
const admin = (id: string, overrides: Partial<UserEntity> = {}) =>
  user(id, { role: UserRole.enum.admin, ...overrides });

const session = (id: string): SessionEntity => ({
  id,
  userId: 'ana',
  tokenHash: `sha(${id})`,
  createdAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(),
  expiresAt: FUTURE,
  version: 0,
});
const token = (id: string, overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id,
  userId: 'ana',
  kind: AccessTokenKind.enum.pat,
  clientName: null,
  profile: null,
  name: id,
  tokenHash: `sha(${id})`,
  prefix: 'ftk_abcdef',
  scopes: ['fintrack:read'],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: FUTURE,
  revokedAt: null,
  version: 0,
  ...overrides,
});
const invite = (id: string, userId = 'ana'): InviteEntity => ({
  id,
  userId,
  codeHash: `sha(${id})`,
  createdBy: 'root',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS).toISOString(),
  usedAt: null,
  version: 0,
});
const approvedGrant: ClientGrantEntity = {
  id: 'g1',
  deviceCodeHash: 'sha(device)',
  userCode: 'ABCDEFGH',
  clientName: 'Claude',
  clientVersion: '1',
  profile: 'default',
  channel: 'stdio',
  hintAccess: null,
  hintDuration: null,
  status: GrantStatus.enum.approved,
  userId: 'ana',
  scopes: ['fintrack:read'],
  duration: '24h',
  createdAt: NOW.toISOString(),
  approvedAt: NOW.toISOString(),
  expiresAt: FUTURE,
  version: 2,
};
const freshInvite = { ...invite('new'), version: undefined } as unknown as Omit<InviteEntity, 'version'>;

const ROOT = admin('root');
const TWO = admin('two');
const ANA = user('ana');
const actingOf = (id: string | null): UserEntity | null => ({ root: ROOT, two: TWO, ana: ANA })[id ?? ''] ?? null;
const NO_HELD = { sessions: [], tokens: [], approvedGrants: [] };
const HELD = {
  sessions: [session('s1'), session('s2')],
  tokens: [token('pat'), token('stdio', { kind: AccessTokenKind.enum.stdio }), token('old', { revokedAt: 'x' })],
  approvedGrants: [approvedGrant],
};

const planOf = <T>(result: { isOk: () => boolean; _unsafeUnwrap: () => T; _unsafeUnwrapErr: () => unknown }): T =>
  result._unsafeUnwrap();

describe('planDisable', () => {
  const facts = {
    actingUserId: 'root',
    acting: ROOT,
    users: [ROOT, ANA],
    held: HELD,
    openInvites: [invite('i1')],
    now: NOW,
  };

  it('disables the user and ends every session, live token and pending invite — and nothing else', () => {
    const plan = planOf(planDisable({ ...facts, target: ANA }));
    expect(plan.userWrites).toEqual([
      { ...ANA, disabledAt: NOW.toISOString(), credentialsChangedAt: NOW.toISOString() },
    ]);
    // The admitted actor is asserted, not rewritten.
    expect(plan.checks).toEqual([ROOT]);
    expect(plan.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(plan.tokens.map((t) => [t.id, t.revokedAt])).toEqual([
      ['pat', NOW.toISOString()],
      ['stdio', NOW.toISOString()],
    ]);
    expect(plan.removedInvites.map((i) => i.id)).toEqual(['i1']);
    expect(plan.newInvites).toEqual([]);
    expect(plan.revoked).toEqual({ sessionsEnded: 2, tokensRevoked: 2 });
    expect(plan.after.disabledAt).toBe(NOW.toISOString());
  });

  it('expires every approved, unredeemed sign-in request of the user, so enabling later mints nothing', () => {
    const plan = planOf(planDisable({ ...facts, target: ANA }));
    expect(plan.expiredGrants).toEqual([{ ...approvedGrant, status: GrantStatus.enum.expired }]);
  });

  it('checks only the acting admin for a member, and every other active admin for an admin', () => {
    expect(planOf(planDisable({ ...facts, target: ANA })).checks.map((u) => u.id)).toEqual(['root']);
    const plan = planOf(planDisable({ ...facts, users: [ROOT, TWO, ANA], target: TWO }));
    expect(plan.userWrites.map((u) => u.id)).toEqual(['two']);
    expect(plan.checks).toEqual([ROOT]);
  });

  it('is a no-op for a user already disabled', () => {
    const plan = planOf(planDisable({ ...facts, target: user('ana', { disabledAt: 'x' }) }));
    expect(plan).toMatchObject({
      userWrites: [],
      checks: [],
      sessions: [],
      tokens: [],
      removedInvites: [],
      newInvites: [],
    });
    expect(plan.revoked).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
  });

  it.each([
    ['themself', 'root', [ROOT, TWO], ROOT, authErrors.cannotChangeSelf],
    ['the last active admin', null, [ROOT, ANA], ROOT, authErrors.lastAdmin],
    [
      'the last active admin among disabled ones',
      'ana',
      [ROOT, admin('two', { disabledAt: 'x' })],
      ROOT,
      authErrors.lastAdmin,
    ],
  ])('refuses disabling %s', (_label, actingUserId, users, target, error) => {
    expect(
      planDisable({ ...facts, actingUserId, acting: actingOf(actingUserId), users, target })._unsafeUnwrapErr(),
    ).toEqual(error);
  });
});

describe('planReissue', () => {
  const facts = {
    actingUserId: 'root',
    acting: ROOT,
    users: [ROOT, TWO, ANA],
    held: HELD,
    openInvites: [invite('i1')],
    invite: freshInvite,
    now: NOW,
  };

  it('replaces the unclaimed invite for a user who has not claimed one, touching nothing else', () => {
    const waiting = user('ana', { passwordHash: null });
    const plan = planOf(planReissue({ ...facts, target: waiting, held: NO_HELD }));
    expect(plan.removedInvites.map((i) => i.id)).toEqual(['i1']);
    expect(plan.newInvites).toEqual([freshInvite]);
    // The invite is a credential issued to the user: the epoch moves, so a claim or revocation racing this conflicts.
    expect(plan.userWrites).toEqual([{ ...waiting, credentialsChangedAt: NOW.toISOString() }]);
    expect(plan.checks).toEqual([ROOT]);
    expect(plan).toMatchObject({ sessions: [], tokens: [] });
    expect(plan.revoked).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
    expect(plan.after).toEqual(waiting);
  });

  it('resets a claimed user: password cleared, every session and live token ended', () => {
    const plan = planOf(planReissue({ ...facts, target: ANA }));
    expect(plan.userWrites).toEqual([{ ...ANA, passwordHash: null, credentialsChangedAt: NOW.toISOString() }]);
    expect(plan.checks).toEqual([ROOT]);
    expect(plan.sessions).toHaveLength(2);
    expect(plan.tokens.map((t) => t.id)).toEqual(['pat', 'stdio']);
    expect(plan.revoked).toEqual({ sessionsEnded: 2, tokensRevoked: 2 });
    expect(plan.after.passwordHash).toBeNull();
  });

  it('expires the approved, unredeemed sign-in requests on a reissue too', () => {
    expect(planOf(planReissue({ ...facts, target: ANA })).expiredGrants.map((g) => g.status)).toEqual(['expired']);
  });

  it('checks the admins left standing when it resets an admin, and only then', () => {
    expect(planOf(planReissue({ ...facts, target: TWO })).checks.map((u) => u.id)).toEqual(['root']);
    expect(planOf(planReissue({ ...facts, target: ANA })).checks.map((u) => u.id)).toEqual(['root']);
  });

  it('keeps a never-set-up owner (no username yet) on the setup path: reissuing it would claim into nothing', () => {
    const unnamedOwner = admin('owner', { username: null, passwordHash: null });
    expect(planReissue({ ...facts, users: [ROOT, unnamedOwner], target: unnamedOwner })._unsafeUnwrapErr()).toEqual(
      authErrors.ownerUnclaimed,
    );
    // A user with a username but no password yet is an ordinary invited user: reissue stays available.
    expect(planReissue({ ...facts, target: user('bob', { passwordHash: null }) }).isOk()).toBe(true);
  });

  it('refuses a disabled user and the last active admin, but lets an admin reset themself if another stands', () => {
    expect(planReissue({ ...facts, target: user('ana', { disabledAt: 'x' }) })._unsafeUnwrapErr()).toEqual(
      authErrors.userDisabled,
    );
    expect(planReissue({ ...facts, users: [ROOT, ANA], target: ROOT })._unsafeUnwrapErr()).toEqual(
      authErrors.lastAdmin,
    );
    expect(planReissue({ ...facts, target: ROOT }).isOk()).toBe(true);
  });
});

describe('planRole', () => {
  const facts = { actingUserId: 'root', acting: ROOT, users: [ROOT, TWO, ANA], now: NOW };

  it('promotes a member with no guard, checking only the acting admin', () => {
    const plan = planOf(planRole({ ...facts, target: ANA, role: UserRole.enum.admin }));
    expect(plan.userWrites).toEqual([{ ...ANA, role: 'admin' }]);
    expect(plan.checks).toEqual([ROOT]);
    expect(plan).toMatchObject({ sessions: [], tokens: [], removedInvites: [], newInvites: [] });
  });

  it('demotes another admin and checks the admins left standing', () => {
    const plan = planOf(planRole({ ...facts, target: TWO, role: UserRole.enum.member }));
    expect(plan.userWrites.map((u) => [u.id, u.role])).toEqual([['two', 'member']]);
    expect(plan.checks.map((u) => [u.id, u.role])).toEqual([['root', 'admin']]);
  });

  it('is a no-op for the role the user already has', () => {
    expect(planOf(planRole({ ...facts, target: ANA, role: UserRole.enum.member })).userWrites).toEqual([]);
  });

  it('refuses demoting oneself or the last active admin', () => {
    expect(planRole({ ...facts, target: ROOT, role: UserRole.enum.member })._unsafeUnwrapErr()).toEqual(
      authErrors.cannotChangeSelf,
    );
    expect(
      planRole({
        ...facts,
        actingUserId: null,
        users: [ROOT, ANA],
        target: ROOT,
        role: UserRole.enum.member,
      })._unsafeUnwrapErr(),
    ).toEqual(authErrors.lastAdmin);
  });
});

describe('the admitted actor is the snapshot every write is built from', () => {
  const facts = { actingUserId: 'root', users: [ROOT, TWO, ANA], now: NOW };
  const staleRoot = { ...ROOT, version: 1 };
  const freshRoot = { ...ROOT, version: 5 };

  it('checks the admins at the admitted version, not at a fresher one read afterwards', () => {
    const plan = planOf(
      planDisable({
        ...facts,
        acting: staleRoot,
        users: [freshRoot, TWO, ANA],
        target: TWO,
        held: NO_HELD,
        openInvites: [],
      }),
    );
    expect(plan.checks.map((u) => [u.id, u.version])).toEqual([['root', 1]]);
  });

  it('checks the actor’s own row when nothing else would, exactly once, and never writes it', () => {
    const plan = planOf(planRole({ ...facts, acting: staleRoot, target: ANA, role: UserRole.enum.admin }));
    expect(plan.checks.filter((u) => u.id === 'root')).toEqual([staleRoot]);
    expect(plan.userWrites.map((u) => u.id)).toEqual(['ana']);
  });

  it('does not let an admin undo a demotion that landed after their admission by setting their own role', () => {
    const plan = planOf(planRole({ ...facts, acting: staleRoot, target: staleRoot, role: UserRole.enum.admin }));
    expect(plan.userWrites).toEqual([]);
    expect(plan.checks).toEqual([]);
  });
});
