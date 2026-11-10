import { PersistOp, type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import { InstanceKind } from '../../../../src/models/instance.js';
import type { ResultAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../../src/common/errors.js';
import {
  claimInvite,
  currentSignInCap,
  disableUser,
  enableUser,
  inviteUser,
  listUsers,
  pruneExpiredInvites,
  reissueInvite,
  resolveUserId,
  setRole,
  setSignInCap,
} from '../../../../src/controllers/auth/users.js';
import type { AuthDeps, AuthSecrets } from '../../../../src/controllers/deps.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  INSTANCE_SETTINGS_ENTITY_TAG,
  INVITE_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  USER_ENTITY_TAG,
} from '../../../../src/models/auth/entity.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { type UserEntity, UserRole } from '../../../../src/models/auth/owner.js';
import { PrincipalVia } from '../../../../src/models/auth/principal.js';
import { ALL_SCOPES } from '../../../../src/models/auth/scope.js';
import type { SessionEntity } from '../../../../src/models/auth/session.js';
import { type AccessTokenEntity, AccessTokenKind } from '../../../../src/models/auth/token.js';
import {
  INVITE_TTL_MS,
  type Actor,
  type InstanceSettingsEntity,
  type InviteEntity,
  DEFAULT_SIGN_IN_CAP,
  INSTANCE_SETTINGS_ID,
} from '../../../../src/models/auth/users.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
const fakeHash = (password: string): string => `hash:${Buffer.from(password).toString('base64')}`;

const secrets: AuthSecrets = {
  hashPassword: async (password) => fakeHash(password),
  verifyPassword: async (hash, password) => hash === fakeHash(password),
  randomToken: () => 'TOKEN',
  randomAccessToken: () => 'ptk_TOKEN',
  randomSetupCode: () => 'ABCDEFGHJKMNPQRSTVWX',
  randomInviteCode: () => 'JKMNPQRSTVWXABCDEFGH',
  randomUserCode: () => 'ABCDEFGH',
  randomDeviceCode: () => 'DEVICE',
  hashSecret: (secret) => `sha(${secret})`,
  dummyPasswordHash: fakeHash('never-typed'),
};

const user = (id: string, overrides: Partial<UserEntity> = {}): UserEntity => ({
  id,
  username: id,
  passwordHash: fakeHash(PASSWORD),
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

const session = (userId: string, id = `s-${userId}`): SessionEntity => ({
  id,
  userId,
  tokenHash: `sha(${id})`,
  createdAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 1000).toISOString(),
  version: 0,
});

const ACTOR_SESSION_ID = 'actor-session';
const actorSession = (userId: string): SessionEntity => session(userId, ACTOR_SESSION_ID);

const token = (userId: string, overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id: `t-${userId}`,
  userId,
  kind: AccessTokenKind.enum.pat,
  clientName: null,
  profile: null,
  name: 'token',
  tokenHash: 'sha(t)',
  prefix: 'ptk_xxxxxx',
  scopes: [...ALL_SCOPES],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
  revokedAt: null,
  version: 0,
  ...overrides,
});

const invite = (userId: string, overrides: Partial<InviteEntity> = {}): InviteEntity => ({
  id: `i-${userId}`,
  userId,
  codeHash: 'sha(JKMNPQRSTVWXABCDEFGH)',
  createdBy: 'root',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS).toISOString(),
  usedAt: null,
  version: 0,
  ...overrides,
});

type World = {
  users?: UserEntity[];
  sessions?: SessionEntity[];
  tokens?: AccessTokenEntity[];
  invites?: InviteEntity[];
  settings?: InstanceSettingsEntity;
  now?: Date;
};

const depsFor = ({
  users = [],
  sessions = [],
  tokens = [],
  invites = [],
  settings = {
    id: INSTANCE_SETTINGS_ID,
    maxSignInDuration: DEFAULT_SIGN_IN_CAP,
    instanceKind: InstanceKind.enum.standard,
    demoSeededAt: null,
    demoCountry: null,
    version: 0,
  },
  now = NOW,
}: World = {}): AuthDeps => {
  let ids = 0;
  return {
    users: {
      findById: async (id) => users.find((u) => u.id === id) ?? null,
      findByUsername: async (username) => users.find((u) => u.username === username) ?? null,
      listAll: async () => users,
    },
    sessions: {
      findByTokenHash: async () => null,
      listExpired: async () => [],
      // Every admin also holds the browser session the sessionActor below acts through.
      listByUser: async (userId) => [
        ...sessions.filter((s) => s.userId === userId),
        ...(users.some((u) => u.id === userId && u.role === UserRole.enum.admin) ? [actorSession(userId)] : []),
      ],
    },
    accessTokens: {
      findByTokenHash: async () => null,
      findById: async () => null,
      listByUser: async (userId) => tokens.filter((t) => t.userId === userId),
    },
    clientGrants: {
      findByDeviceCodeHash: async () => null,
      findPendingByUserCode: async () => null,
      lastRedeemed: async () => null,
      listApprovedByUser: async () => [],
      listExpired: async () => [],
      listRedeemed: async () => [],
    },
    invites: {
      findByHash: async (hash) => invites.find((i) => i.codeHash === hash) ?? null,
      listUnclaimed: async () => invites.filter((i) => i.usedAt === null),
      listUnclaimedByUser: async (userId) => invites.filter((i) => i.userId === userId && i.usedAt === null),
      listExpiredUnclaimed: async (nowIso) => invites.filter((i) => i.usedAt === null && i.expiresAt <= nowIso),
    },
    instanceSettings: { get: async () => settings },
    setupCodes: { findByHash: async () => null, current: async () => null },
    clock: () => now,
    newId: () => `id-${(ids += 1)}`,
    secrets,
  };
};

const isSessionCheck = (p: Persistable) => p.op === PersistOp.enum.check && p.entity === SESSION_ENTITY_TAG;
/** The batch as the flow reasons about it: the admitted session's check is asserted once, in its own test below. */
const outcomeWithSessionCheck = async <T>(result: ResultAsync<FlowOutcome<T>, AppError>) => {
  const { persist, response } = (await result)._unsafeUnwrap();
  if (typeof response === 'function') throw new Error('expected a plain response');
  return { persist, response };
};
const outcomeOf = async <T>(result: ResultAsync<FlowOutcome<T>, AppError>) => {
  const { persist, response } = await outcomeWithSessionCheck(result);
  return { persist: persist.filter((p) => !isSessionCheck(p)), response };
};
const errorOf = async <T>(result: ResultAsync<T, AppError>): Promise<AppError> => (await result)._unsafeUnwrapErr();
const modelOf = (persistable: Persistable | undefined): unknown =>
  persistable !== undefined && 'model' in persistable ? persistable.model : undefined;

const CHECK_USER = `${PersistOp.enum.check}:${USER_ENTITY_TAG}`;
const checkedIds = (persist: Persistable[]) =>
  persist
    .filter((p) => p.op === PersistOp.enum.check && p.entity === USER_ENTITY_TAG)
    .map((p) => ('id' in p ? p.id : undefined));
const opsOf = (persist: Persistable[]) => persist.map(({ op, entity }) => `${op}:${entity}`);
const countOf = (persist: Persistable[], op: string, entity: string) =>
  persist.filter((p) => p.op === op && p.entity === entity).length;

const sessionActor = (userId: string, password: string | null = PASSWORD): Actor => ({
  kind: 'session',
  principal: {
    userId,
    role: UserRole.enum.admin,
    scopes: [...ALL_SCOPES],
    via: PrincipalVia.enum.session,
    sessionId: ACTOR_SESSION_ID,
  },
  password: password ?? undefined,
});
const TERMINAL: Actor = { kind: 'terminal' };

const ROOT = admin('root');
const ANA = user('ana');

describe('who may run a user-management flow', () => {
  const everyFlow: Array<[string, (deps: AuthDeps, actor: Actor) => ResultAsync<unknown, AppError>]> = [
    ['listUsers', (deps, actor) => listUsers(deps, actor)],
    ['inviteUser', (deps, actor) => inviteUser(deps, actor, { username: 'bob', role: UserRole.enum.member })],
    ['reissueInvite', (deps, actor) => reissueInvite(deps, actor, 'ana')],
    ['disableUser', (deps, actor) => disableUser(deps, actor, 'ana')],
    ['enableUser', (deps, actor) => enableUser(deps, actor, 'ana')],
    ['setRole', (deps, actor) => setRole(deps, actor, { userId: 'ana', role: UserRole.enum.admin })],
    ['setSignInCap', (deps, actor) => setSignInCap(deps, actor, { maxSignInDuration: '7d' })],
  ];
  const world = { users: [ROOT, ANA] };

  it.each(everyFlow)('%s refuses a member as "admin required", writing nothing', async (_name, flow) => {
    expect(await errorOf(flow(depsFor(world), sessionActor('ana')))).toEqual(authErrors.adminRequired);
  });

  it.each(everyFlow)('%s refuses an admin acting through a token or stdio: session-only', async (_name, flow) => {
    for (const via of [PrincipalVia.enum.token, PrincipalVia.enum.stdio]) {
      const actor: Actor = {
        kind: 'session',
        principal: { userId: 'root', role: UserRole.enum.admin, scopes: [...ALL_SCOPES], via },
        password: PASSWORD,
      };
      expect(await errorOf(flow(depsFor(world), actor))).toEqual(authErrors.sessionRequired);
    }
  });

  it.each(everyFlow)(
    '%s refuses an admin whose browser session is gone, however the rest still holds',
    async (_name, flow) => {
      const actor = sessionActor('root');
      const revoked: Actor =
        actor.kind === 'session' ? { ...actor, principal: { ...actor.principal, sessionId: 'revoked' } } : actor;
      expect(await errorOf(flow(depsFor(world), revoked))).toEqual(authErrors.unauthenticated);
    },
  );

  it.each(everyFlow.filter(([name]) => name !== 'listUsers'))(
    '%s asserts the admitted session in its batch (and only the session, once)',
    async (_name, flow) => {
      const result = await flow(depsFor({ users: [ROOT, ANA, admin('two')] }), sessionActor('root'));
      const outcome = (result as { _unsafeUnwrap: () => FlowOutcome<unknown> })._unsafeUnwrap();
      const checks = outcome.persist.filter(isSessionCheck);
      // A flow that changes nothing (already so) writes nothing and needs no check.
      if (outcome.persist.length > 0) {
        expect(checks).toEqual([
          { op: PersistOp.enum.check, entity: SESSION_ENTITY_TAG, id: ACTOR_SESSION_ID, version: 0 },
        ]);
      }
    },
  );

  it.each(everyFlow)('%s refuses an admin who has since been disabled', async (_name, flow) => {
    const deps = depsFor({ users: [admin('root', { disabledAt: NOW.toISOString() }), ANA] });
    expect(await errorOf(flow(deps, sessionActor('root')))).toEqual(authErrors.adminRequired);
  });

  const stepUpFlows = everyFlow.filter(([name]) => name !== 'listUsers');

  it.each(stepUpFlows)(
    '%s re-asks the admin’s password: a wrong or missing one changes nothing',
    async (_name, flow) => {
      const deps = depsFor(world);
      expect(await errorOf(flow(deps, sessionActor('root', 'wrong wrong wrong')))).toEqual(
        authErrors.invalidCredentials,
      );
      expect(await errorOf(flow(deps, sessionActor('root', null)))).toEqual(authErrors.invalidCredentials);
    },
  );

  it.each(stepUpFlows)('%s asks the trusted terminal for no password', async (_name, flow) => {
    const result = await flow(depsFor(world), TERMINAL);
    // Whatever the flow decides about its subject, it does not refuse the terminal as an actor or for a password.
    expect(result.isErr() ? result.error.code : '').not.toMatch(/admin_required|session_required|invalid_credentials/);
  });

  it('lets listing go without a password: it changes nothing', async () => {
    const deps = depsFor({ users: [ROOT, ANA] });
    expect((await listUsers(deps, sessionActor('root', null))).isOk()).toBe(true);
  });

  it('asks for the password to enable too: a wrong one leaves the user disabled, nothing written', async () => {
    const disabled = user('ana', { disabledAt: NOW.toISOString() });
    const deps = depsFor({ users: [ROOT, disabled] });
    expect(await errorOf(enableUser(deps, sessionActor('root', 'wrong wrong wrong'), 'ana'))).toEqual(
      authErrors.invalidCredentials,
    );
    expect((await enableUser(deps, sessionActor('root'), 'ana')).isOk()).toBe(true);
  });
});

describe('listUsers', () => {
  it('summarizes everyone, with the invite that is waiting, and no hashes', async () => {
    const waiting = user('bob', { passwordHash: null });
    const deps = depsFor({ users: [ROOT, ANA, waiting], invites: [invite('bob')] });
    const list = (await listUsers(deps, sessionActor('root')))._unsafeUnwrap();
    expect(list.map((u) => [u.username, u.status, u.inviteExpiresAt !== null])).toEqual([
      ['root', 'active', false],
      ['ana', 'active', false],
      ['bob', 'invited', true],
    ]);
    expect(JSON.stringify(list)).not.toContain('hash');
  });
});

describe('inviteUser', () => {
  it('inserts the unclaimed user and its invite together, returning the plaintext code once', async () => {
    const { persist, response } = await outcomeOf(
      inviteUser(depsFor({ users: [ROOT] }), sessionActor('root'), { username: 'bob', role: UserRole.enum.member }),
    );
    expect(opsOf(persist)).toEqual([
      // The acting admin's row, asserted: demoted meanwhile, this invite conflicts and is refused.
      CHECK_USER,
      `${PersistOp.enum.insert}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.insert}:${INVITE_ENTITY_TAG}`,
    ]);
    expect(modelOf(persist[1])).toMatchObject({
      username: 'bob',
      passwordHash: null,
      role: 'member',
      disabledAt: null,
    });
    expect(modelOf(persist[2])).toMatchObject({
      userId: 'id-1',
      createdBy: 'root',
      usedAt: null,
      expiresAt: new Date(NOW.getTime() + INVITE_TTL_MS).toISOString(),
    });
    expect(response.code).toBe('JKMN-PQRS-TVWX-ABCD-EFGH');
    expect(response.user).toMatchObject({ username: 'bob', role: 'member', status: 'invited' });
    expect(response.revoked).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
  });

  it('stores only the code’s hash, never the code', async () => {
    const { persist } = await outcomeOf(
      inviteUser(depsFor({ users: [ROOT] }), sessionActor('root'), { username: 'bob', role: UserRole.enum.admin }),
    );
    const stored = JSON.stringify(persist);
    expect(stored).toContain('sha(JKMNPQRSTVWXABCDEFGH)');
    expect(stored).not.toContain('JKMN-PQRS');
    expect(modelOf(persist[1])).toMatchObject({ role: 'admin' });
  });

  it('attributes a terminal invite to nobody', async () => {
    const { persist } = await outcomeOf(
      inviteUser(depsFor({ users: [ROOT] }), TERMINAL, { username: 'bob', role: UserRole.enum.member }),
    );
    // The terminal has no row to assert, so the batch starts with the inserts.
    expect(opsOf(persist)).not.toContain(CHECK_USER);
    expect(modelOf(persist[1])).toMatchObject({ createdBy: null });
  });

  it('refuses a username that is taken, and writes nothing', async () => {
    const deps = depsFor({ users: [ROOT, ANA] });
    expect(await errorOf(inviteUser(deps, sessionActor('root'), { username: 'ana', role: 'member' }))).toEqual(
      authErrors.usernameTaken('ana'),
    );
  });

  it('refuses the username of a user who has not claimed their invite yet', async () => {
    const deps = depsFor({ users: [ROOT, user('bob', { passwordHash: null })] });
    expect((await errorOf(inviteUser(deps, sessionActor('root'), { username: 'bob', role: 'member' }))).code).toBe(
      'username_taken',
    );
  });

  it('also treats a disabled user’s name as taken: users are never deleted', async () => {
    const deps = depsFor({ users: [ROOT, user('ana', { disabledAt: NOW.toISOString() })] });
    expect((await errorOf(inviteUser(deps, sessionActor('root'), { username: 'ana', role: 'member' }))).code).toBe(
      'username_taken',
    );
  });
});

describe('reissueInvite', () => {
  it('gives a user who never claimed a new invite, replacing the old one in the same batch', async () => {
    const waiting = user('bob', { passwordHash: null });
    const { persist, response } = await outcomeOf(
      reissueInvite(depsFor({ users: [ROOT, waiting], invites: [invite('bob')] }), sessionActor('root'), 'bob'),
    );
    expect(opsOf(persist)).toEqual([
      // The acting admin is asserted; the target's credential epoch moves with the new invite.
      CHECK_USER,
      `${PersistOp.enum.delete}:${INVITE_ENTITY_TAG}`,
      `${PersistOp.enum.insert}:${INVITE_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
    ]);
    expect(checkedIds(persist)).toEqual(['root']);
    expect(modelOf(persist[3])).toMatchObject({ id: 'bob', credentialsChangedAt: NOW.toISOString() });
    expect(response.revoked).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
    expect(response.code).toBe('JKMN-PQRS-TVWX-ABCD-EFGH');
  });

  it('removes an expired, unclaimed invite too: at most one waits per user', async () => {
    const waiting = user('bob', { passwordHash: null });
    const stale = invite('bob', { expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    const { persist } = await outcomeOf(
      reissueInvite(depsFor({ users: [ROOT, waiting], invites: [stale] }), sessionActor('root'), 'bob'),
    );
    expect(countOf(persist, PersistOp.enum.delete, INVITE_ENTITY_TAG)).toBe(1);
  });

  it('is an admin-driven reset for a claimed user: password cleared, every session, token, sign-in ended', async () => {
    const stdio = token('ana', { id: 't-stdio', kind: AccessTokenKind.enum.stdio, clientName: 'Claude' });
    const world = {
      users: [ROOT, ANA],
      sessions: [session('ana', 's1'), session('ana', 's2')],
      tokens: [token('ana'), stdio],
    };
    const { persist, response } = await outcomeOf(reissueInvite(depsFor(world), sessionActor('root'), 'ana'));

    expect(response.revoked).toEqual({ sessionsEnded: 2, tokensRevoked: 2 });
    expect(countOf(persist, PersistOp.enum.delete, SESSION_ENTITY_TAG)).toBe(2);
    const revoked = persist.filter((p) => p.entity === ACCESS_TOKEN_ENTITY_TAG);
    expect(revoked.map((p) => (modelOf(p) as AccessTokenEntity).revokedAt)).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
    ]);
    const cleared = persist.find(
      (p) => p.op === PersistOp.enum.update && p.entity === USER_ENTITY_TAG && (modelOf(p) as UserEntity).id === 'ana',
    );
    expect((modelOf(cleared) as UserEntity).passwordHash).toBeNull();
    expect(response.user.status).toBe('invited');
  });

  it('leaves tokens that were already revoked or expired alone', async () => {
    const world = {
      users: [ROOT, ANA],
      tokens: [
        token('ana', { id: 'old', revokedAt: '2026-01-01T00:00:00.000Z' }),
        token('ana', { id: 'lapsed', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ],
    };
    const { response } = await outcomeOf(reissueInvite(depsFor(world), sessionActor('root'), 'ana'));
    expect(response.revoked.tokensRevoked).toBe(0);
  });

  it('refuses a disabled user: enable them first', async () => {
    const deps = depsFor({ users: [ROOT, user('ana', { disabledAt: NOW.toISOString() })] });
    expect(await errorOf(reissueInvite(deps, sessionActor('root'), 'ana'))).toEqual(authErrors.userDisabled);
  });

  it('refuses an unknown user', async () => {
    expect(await errorOf(reissueInvite(depsFor({ users: [ROOT] }), sessionActor('root'), 'nobody'))).toEqual(
      authErrors.unknownUser('nobody'),
    );
  });

  it('refuses to reset the only active admin: it would leave nobody to administer', async () => {
    const deps = depsFor({ users: [ROOT, ANA] });
    expect(await errorOf(reissueInvite(deps, sessionActor('root'), 'root'))).toEqual(authErrors.lastAdmin);
    expect(await errorOf(reissueInvite(deps, TERMINAL, 'root'))).toEqual(authErrors.lastAdmin);
  });

  it('lets an admin reset another admin, checking the admins left standing (so races conflict)', async () => {
    const two = admin('two');
    const { persist } = await outcomeOf(reissueInvite(depsFor({ users: [ROOT, two] }), sessionActor('root'), 'two'));
    expect(checkedIds(persist)).toEqual(['root']);
    const written = persist.filter((p) => p.op === PersistOp.enum.update && p.entity === USER_ENTITY_TAG);
    expect(written.map((p) => (modelOf(p) as UserEntity).id)).toEqual(['two']);
  });
});

describe('claimInvite', () => {
  const waiting = user('bob', { passwordHash: null });
  const input = { code: 'jkmn-pqrs-tvwx-abcd-efgh', password: 'a brand new passphrase' };
  const world = { users: [ROOT, waiting], invites: [invite('bob')] };

  it('updates the existing row, spends the invite and starts a session in one batch, inserting no user', async () => {
    const { persist, response } = await outcomeOf(claimInvite(depsFor(world), input));
    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${INVITE_ENTITY_TAG}`,
      `${PersistOp.enum.insert}:${SESSION_ENTITY_TAG}`,
    ]);
    expect(modelOf(persist[0])).toMatchObject({
      id: 'bob',
      username: 'bob',
      passwordHash: fakeHash(input.password),
      lastLoginAt: NOW.toISOString(),
    });
    expect(modelOf(persist[1])).toMatchObject({ usedAt: NOW.toISOString() });
    expect(response.token).toBe('TOKEN');
    expect(JSON.stringify(persist)).not.toContain('"TOKEN"');
    expect(JSON.stringify(persist)).not.toContain(input.password);
  });

  it.each([
    ['an unknown code', { ...input, code: 'ZZZZ-ZZZZ' }, world],
    ['an invite already used', input, { ...world, invites: [invite('bob', { usedAt: NOW.toISOString() })] }],
    [
      'an expired invite',
      input,
      { ...world, invites: [invite('bob', { expiresAt: new Date(NOW.getTime() - 1).toISOString() })] },
    ],
    [
      'an invite for a disabled user',
      input,
      { ...world, users: [ROOT, { ...waiting, disabledAt: NOW.toISOString() }] },
    ],
    ['an invite whose user has since claimed a login', input, { ...world, users: [ROOT, user('bob')] }],
    ['an invite whose user is gone', input, { ...world, users: [ROOT] }],
  ])('refuses %s with the one generic error', async (_label, attempt, scenario) => {
    expect(await errorOf(claimInvite(depsFor(scenario), attempt))).toEqual(authErrors.invalidInvite);
  });

  it('reads the code as a person types it: case, dashes and spaces never matter', async () => {
    const typed = { ...input, code: ' JKMN PQRS tvwx-ABCD efgh ' };
    expect((await claimInvite(depsFor(world), typed)).isOk()).toBe(true);
  });

  it('refuses an invite issued for someone else’s code: only the matching hash claims', async () => {
    const other = { ...world, invites: [invite('bob', { codeHash: 'sha(SOMETHINGELSE)' })] };
    expect(await errorOf(claimInvite(depsFor(other), input))).toEqual(authErrors.invalidInvite);
  });
});

describe('disableUser', () => {
  it('disables and ends every session, token and stdio sign-in in the SAME batch', async () => {
    const stdio = token('ana', { id: 't-stdio', kind: AccessTokenKind.enum.stdio });
    const world = { users: [ROOT, ANA], sessions: [session('ana')], tokens: [token('ana'), stdio] };
    const { persist, response } = await outcomeOf(disableUser(depsFor(world), sessionActor('root'), 'ana'));

    expect(opsOf(persist)).toEqual([
      CHECK_USER,
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${ACCESS_TOKEN_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${ACCESS_TOKEN_ENTITY_TAG}`,
    ]);
    expect(modelOf(persist[1])).toMatchObject({ id: 'ana', disabledAt: NOW.toISOString() });
    expect(response.revoked).toEqual({ sessionsEnded: 1, tokensRevoked: 2 });
    expect(response.user.status).toBe('disabled');
  });

  it('touches only that user’s credentials', async () => {
    const world = { users: [ROOT, ANA], sessions: [session('ana'), session('root')], tokens: [token('root')] };
    const { persist } = await outcomeOf(disableUser(depsFor(world), sessionActor('root'), 'ana'));
    expect(JSON.stringify(persist)).not.toContain('s-root');
    expect(JSON.stringify(persist)).not.toContain('t-root');
  });

  it('is idempotent: a user already disabled changes nothing', async () => {
    const disabled = user('ana', { disabledAt: '2026-01-01T00:00:00.000Z' });
    const { persist } = await outcomeOf(disableUser(depsFor({ users: [ROOT, disabled] }), sessionActor('root'), 'ana'));
    expect(persist).toEqual([]);
  });

  it('refuses an admin disabling themself', async () => {
    const deps = depsFor({ users: [ROOT, admin('two')] });
    expect(await errorOf(disableUser(deps, sessionActor('root'), 'root'))).toEqual(authErrors.cannotChangeSelf);
  });

  it('refuses to disable the last active admin', async () => {
    const deps = depsFor({ users: [ROOT, ANA] });
    expect(await errorOf(disableUser(deps, TERMINAL, 'root'))).toEqual(authErrors.lastAdmin);
  });

  it('checks the remaining admins so two admins disabling each other cannot both commit', async () => {
    const two = admin('two');
    const { persist } = await outcomeOf(disableUser(depsFor({ users: [ROOT, two] }), sessionActor('root'), 'two'));
    expect(persist[0]).toEqual({
      op: PersistOp.enum.check,
      entity: USER_ENTITY_TAG,
      id: 'root',
      version: ROOT.version,
    });
    expect(persist.filter((p) => p.op === PersistOp.enum.update && p.entity === USER_ENTITY_TAG)).toHaveLength(1);
  });

  it('removes a pending invite in the same batch, so enabling later revives nothing', async () => {
    const waiting = user('bob', { passwordHash: null });
    const { persist } = await outcomeOf(
      disableUser(depsFor({ users: [ROOT, waiting], invites: [invite('bob')] }), sessionActor('root'), 'bob'),
    );
    expect(countOf(persist, PersistOp.enum.delete, INVITE_ENTITY_TAG)).toBe(1);
  });

  it('checks no other admin when the disabled user is not an admin, only the acting admin’s own row', async () => {
    const { persist } = await outcomeOf(disableUser(depsFor({ users: [ROOT, ANA] }), sessionActor('root'), 'ana'));
    expect(checkedIds(persist)).toEqual(['root']);
    expect(persist.filter((p) => p.op === PersistOp.enum.update && p.entity === USER_ENTITY_TAG).map(modelOf)).toEqual([
      { ...ANA, disabledAt: NOW.toISOString(), credentialsChangedAt: NOW.toISOString() },
    ]);
  });
});

describe('enableUser', () => {
  const disabled = user('ana', { disabledAt: '2026-10-01T00:00:00.000Z' });

  it('restores the ability to log in and writes nothing else: no credential is revived', async () => {
    const world = { users: [ROOT, disabled], tokens: [token('ana', { revokedAt: '2026-10-01T00:00:00.000Z' })] };
    const { persist, response } = await outcomeOf(enableUser(depsFor(world), sessionActor('root'), 'ana'));
    expect(opsOf(persist)).toEqual([CHECK_USER, `${PersistOp.enum.update}:${USER_ENTITY_TAG}`]);
    expect(checkedIds(persist)).toEqual(['root']);
    expect(modelOf(persist[1])).toMatchObject({ id: 'ana', disabledAt: null });
    expect(response.revoked).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
  });

  it('is idempotent for a user who is already enabled', async () => {
    const { persist } = await outcomeOf(enableUser(depsFor({ users: [ROOT, ANA] }), sessionActor('root'), 'ana'));
    expect(persist).toEqual([]);
  });
});

describe('setRole', () => {
  it('promotes a member without any guard, checking only the acting admin', async () => {
    const { persist, response } = await outcomeOf(
      setRole(depsFor({ users: [ROOT, ANA] }), sessionActor('root'), { userId: 'ana', role: UserRole.enum.admin }),
    );
    expect(checkedIds(persist)).toEqual(['root']);
    expect(persist.map((p) => modelOf(p))).toEqual([undefined, { ...ANA, role: 'admin' }]);
    expect(response.user.role).toBe('admin');
  });

  it('demotes another admin and checks the admins left standing', async () => {
    const { persist } = await outcomeOf(
      setRole(depsFor({ users: [ROOT, admin('two')] }), sessionActor('root'), { userId: 'two', role: 'member' }),
    );
    expect(checkedIds(persist)).toEqual(['root']);
    expect(modelOf(persist[1])).toMatchObject({ id: 'two', role: 'member' });
  });

  it('is idempotent for a role the user already has', async () => {
    const { persist } = await outcomeOf(
      setRole(depsFor({ users: [ROOT, ANA] }), sessionActor('root'), { userId: 'ana', role: 'member' }),
    );
    expect(persist).toEqual([]);
  });

  it('refuses an admin demoting themself', async () => {
    const deps = depsFor({ users: [ROOT, admin('two')] });
    expect(await errorOf(setRole(deps, sessionActor('root'), { userId: 'root', role: 'member' }))).toEqual(
      authErrors.cannotChangeSelf,
    );
  });

  it('refuses to demote the last active admin', async () => {
    const deps = depsFor({ users: [ROOT, ANA] });
    expect(await errorOf(setRole(deps, TERMINAL, { userId: 'root', role: 'member' }))).toEqual(authErrors.lastAdmin);
  });
});

describe('setSignInCap', () => {
  it('updates the existing singleton at the version read, asserting the acting admin first', async () => {
    const settings = {
      id: INSTANCE_SETTINGS_ID,
      maxSignInDuration: '7d' as const,
      instanceKind: InstanceKind.enum.standard,
      demoSeededAt: null,
      demoCountry: null,
      version: 3,
    };
    const changed = await outcomeOf(
      setSignInCap(depsFor({ users: [ROOT], settings }), sessionActor('root'), { maxSignInDuration: '24h' }),
    );
    expect(opsOf(changed.persist)).toEqual([CHECK_USER, `${PersistOp.enum.update}:${INSTANCE_SETTINGS_ENTITY_TAG}`]);
    expect(modelOf(changed.persist[1])).toEqual({
      id: INSTANCE_SETTINGS_ID,
      maxSignInDuration: '24h',
      instanceKind: InstanceKind.enum.standard,
      demoSeededAt: null,
      demoCountry: null,
      version: 3,
    });
  });

  it('changes nothing when the cap is already that value, including the default', async () => {
    const same = await outcomeOf(setSignInCap(depsFor({ users: [ROOT] }), TERMINAL, { maxSignInDuration: '30d' }));
    expect(same.persist).toEqual([]);
  });

  it('reads the default (30 days) until an admin sets one', async () => {
    expect(await currentSignInCap(depsFor())).toBe('30d');
    expect(
      await currentSignInCap(
        depsFor({
          settings: {
            id: INSTANCE_SETTINGS_ID,
            maxSignInDuration: '24h',
            instanceKind: InstanceKind.enum.standard,
            demoSeededAt: null,
            demoCountry: null,
            version: 0,
          },
        }),
      ),
    ).toBe('24h');
  });
});

describe('resolveUserId', () => {
  it('finds a user by their normalized username, else says there is no such user', async () => {
    const deps = depsFor({ users: [ROOT, ANA] });
    expect((await resolveUserId(deps, 'ana'))._unsafeUnwrap()).toBe('ana');
    expect(await errorOf(resolveUserId(deps, 'nobody'))).toEqual(authErrors.unknownUser('nobody'));
  });
});

describe('pruneExpiredInvites', () => {
  it('deletes unclaimed invites past their window and nothing else', async () => {
    const lapsed = invite('bob', { expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    const world = {
      users: [ROOT],
      invites: [lapsed, invite('ana'), invite('used', { usedAt: NOW.toISOString(), expiresAt: lapsed.expiresAt })],
    };
    const { persist, response } = await outcomeOf(pruneExpiredInvites(depsFor(world)));
    expect(response).toBe(1);
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.delete}:${INVITE_ENTITY_TAG}`]);
  });
});
