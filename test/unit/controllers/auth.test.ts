import { DEFAULT_SIGN_IN_CAP, INSTANCE_SETTINGS_ID } from '../../../src/models/auth/users.js';
import { PersistOp, type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import type { ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../src/common/errors.js';
import {
  authenticate,
  claimedOwnerOf,
  claimOwner,
  claimOwnerLocally,
  claimRaceWinnerOf,
  findResetTarget,
  issueSetupCode,
  login,
  logout,
  ownerClaimPlan,
  ownerNeedsSetup,
  pruneExpiredSessions,
  resetPassword,
} from '../../../src/controllers/auth.js';
import type { AuthDeps, AuthSecrets } from '../../../src/controllers/deps.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  USER_ENTITY_TAG,
} from '../../../src/models/auth/entity.js';
import { authErrors } from '../../../src/models/auth/errors.js';
import { AuthMode } from '../../../src/models/auth/mode.js';
import {
  OWNER_USER_ID,
  SETUP_CODE_ID,
  SETUP_CODE_TTL_MS,
  type SetupCodeEntity,
  type UserEntity,
  UserRole,
} from '../../../src/models/auth/owner.js';
import { PrincipalVia } from '../../../src/models/auth/principal.js';
import { ALL_SCOPES } from '../../../src/models/auth/scope.js';
import {
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type SessionEntity,
} from '../../../src/models/auth/session.js';
import { type AccessTokenEntity, AccessTokenKind } from '../../../src/models/auth/token.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';

// A stand-in that is deterministic but does not embed the plaintext, so "never stored" is assertable.
const fakeHash = (password: string): string => `hash:${Buffer.from(password).toString('base64')}`;

const secrets: AuthSecrets = {
  hashPassword: async (password) => fakeHash(password),
  verifyPassword: async (hash, password) => hash === fakeHash(password),
  randomToken: () => 'TOKEN',
  randomAccessToken: () => 'ftk_TOKEN',
  randomSetupCode: () => 'ABCDEFGHJKMNPQRSTVWX',
  randomInviteCode: () => 'JKMNPQRSTVWXABCDEFGH',
  randomUserCode: () => 'ABCDEFGH',
  randomDeviceCode: () => 'DEVICE',
  hashSecret: (secret) => `sha(${secret})`,
  dummyPasswordHash: fakeHash('never-typed'),
};

const unclaimedOwner = (): UserEntity => ({
  id: OWNER_USER_ID,
  username: null,
  passwordHash: null,
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  version: 0,
});
const claimedOwner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  ...unclaimedOwner(),
  username: 'rafael',
  passwordHash: fakeHash(PASSWORD),
  version: 1,
  ...overrides,
});

type World = {
  users?: UserEntity[];
  sessions?: SessionEntity[];
  codes?: SetupCodeEntity[];
  tokens?: AccessTokenEntity[];
  now?: Date;
};

const depsFor = ({ users = [], sessions = [], codes = [], tokens = [], now = NOW }: World = {}): AuthDeps => {
  let ids = 0;
  return {
    users: {
      findById: async (id) => users.find((user) => user.id === id) ?? null,
      findByUsername: async (username) => users.find((user) => user.username === username) ?? null,
      listAll: async () => users,
    },
    sessions: {
      findByTokenHash: async (hash) => sessions.find((session) => session.tokenHash === hash) ?? null,
      listExpired: async (nowIso) => sessions.filter((session) => session.expiresAt <= nowIso),
      listByUser: async (userId) => sessions.filter((session) => session.userId === userId),
    },
    accessTokens: {
      findByTokenHash: async (hash) => tokens.find((token) => token.tokenHash === hash) ?? null,
      findById: async (userId, id) => tokens.find((token) => token.userId === userId && token.id === id) ?? null,
      listByUser: async (userId) => tokens.filter((token) => token.userId === userId),
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
      findByHash: async () => null,
      listUnclaimed: async () => [],
      listUnclaimedByUser: async () => [],
      listExpiredUnclaimed: async () => [],
    },
    instanceSettings: {
      get: async () => ({ id: INSTANCE_SETTINGS_ID, maxSignInDuration: DEFAULT_SIGN_IN_CAP, version: 0 }),
    },
    setupCodes: {
      findByHash: async (hash) => codes.find((code) => code.codeHash === hash) ?? null,
      current: async () => codes.find((code) => code.id === SETUP_CODE_ID) ?? null,
    },
    clock: () => now,
    newId: () => `id-${(ids += 1)}`,
    secrets,
  };
};

// Every auth flow returns a plain (not outcome-dependent) response.
const outcomeOf = async <T>(
  result: ResultAsync<FlowOutcome<T>, AppError>,
): Promise<{ persist: Persistable[]; response: T }> => {
  const { persist, response } = (await result)._unsafeUnwrap();
  if (typeof response === 'function') throw new Error('expected a plain response');
  return { persist, response };
};
const errorOf = async <T>(result: ResultAsync<T, AppError>): Promise<AppError> => (await result)._unsafeUnwrapErr();

const opsOf = (persist: Persistable[]) => persist.map(({ op, entity }) => `${op}:${entity}`);

const sessionRow = (overrides: Partial<SessionEntity> = {}): SessionEntity => ({
  id: 's1',
  userId: OWNER_USER_ID,
  tokenHash: 'sha(TOKEN)',
  createdAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + SESSION_IDLE_TTL_MS).toISOString(),
  version: 0,
  ...overrides,
});

const codeRow = (overrides: Partial<SetupCodeEntity> = {}): SetupCodeEntity => ({
  id: SETUP_CODE_ID,
  codeHash: 'sha(ABCDEFGHJKMNPQRSTVWX)',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + SETUP_CODE_TTL_MS).toISOString(),
  usedAt: null,
  version: 0,
  ...overrides,
});

describe('issueSetupCode', () => {
  it('mints a code for an unclaimed owner under required auth, storing only its hash', async () => {
    const { persist, response } = await outcomeOf(
      issueSetupCode(depsFor({ users: [unclaimedOwner()] }), AuthMode.enum.required),
    );

    expect(response?.code).toBe('ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(response?.expiresAt).toBe(new Date(NOW.getTime() + SETUP_CODE_TTL_MS).toISOString());
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.insert}:${SETUP_CODE_ENTITY_TAG}`]);
    const stored = JSON.stringify(persist);
    expect(stored).toContain('sha(ABCDEFGHJKMNPQRSTVWX)');
    expect(stored).not.toContain('ABCD-EFGH');
  });

  it('replaces the single setup-code row in place, so a restart invalidates the previous code', async () => {
    const earlier = codeRow({ codeHash: 'sha(PREVIOUS)', usedAt: NOW.toISOString(), version: 3 });
    const { persist } = await outcomeOf(
      issueSetupCode(depsFor({ users: [unclaimedOwner()], codes: [earlier] }), AuthMode.enum.required),
    );
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.update}:${SETUP_CODE_ENTITY_TAG}`]);
    expect((persist[0] as { model: SetupCodeEntity }).model).toMatchObject({
      id: SETUP_CODE_ID,
      codeHash: 'sha(ABCDEFGHJKMNPQRSTVWX)',
      usedAt: null,
      version: 3, // version-guarded against the row it read
    });
  });

  it('inserts the singleton the first time, under its fixed id', async () => {
    const { persist } = await outcomeOf(issueSetupCode(depsFor({ users: [unclaimedOwner()] }), AuthMode.enum.required));
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.insert, model: { id: SETUP_CODE_ID } });
  });

  it.each([
    ['auth is disabled', AuthMode.enum.disabled, unclaimedOwner()],
    ['the owner is claimed', AuthMode.enum.required, claimedOwner()],
  ])('issues nothing when %s', async (_label, mode, owner) => {
    const { persist, response } = await outcomeOf(issueSetupCode(depsFor({ users: [owner] }), mode));
    expect(response).toBeNull();
    expect(persist).toEqual([]);
  });
});

describe('claimOwner', () => {
  const input = { code: 'abcd-efgh-jkmn-pqrs-tvwx', username: 'rafael', password: PASSWORD };

  const invitedRafael = (): UserEntity => ({
    ...claimedOwner({ id: 'u-ana', passwordHash: null, role: UserRole.enum.member }),
    username: 'rafael',
  });

  it('refuses a username an invited user already holds (the owner is not yet set up), writing nothing', async () => {
    const deps = depsFor({ users: [unclaimedOwner(), invitedRafael()], codes: [codeRow()] });
    expect(await errorOf(claimOwner(deps, input))).toEqual(authErrors.usernameTaken('rafael'));
  });

  it('does not say whether a name is taken to someone without a valid setup code', async () => {
    const deps = depsFor({ users: [unclaimedOwner(), invitedRafael()], codes: [] });
    expect(await errorOf(claimOwner(deps, input))).toEqual(authErrors.invalidSetupCode);
  });

  it('updates the EXISTING owner and never inserts a user', async () => {
    const deps = depsFor({ users: [unclaimedOwner()], codes: [codeRow()] });
    const { persist, response } = await outcomeOf(claimOwner(deps, input));

    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${SETUP_CODE_ENTITY_TAG}`,
      `${PersistOp.enum.insert}:${SESSION_ENTITY_TAG}`,
    ]);
    expect(persist.filter((p) => p.entity === USER_ENTITY_TAG && p.op === PersistOp.enum.insert)).toEqual([]);
    const [userUpdate] = persist as Array<Persistable & { model: UserEntity }>;
    expect(userUpdate?.model).toMatchObject({
      id: OWNER_USER_ID,
      username: 'rafael',
      passwordHash: fakeHash(PASSWORD),
      version: 0,
    });
    expect(response).toEqual({
      token: 'TOKEN',
      expiresAt: new Date(NOW.getTime() + SESSION_IDLE_TTL_MS).toISOString(),
    });
  });

  it('consumes the code and stores the session by hash only', async () => {
    const { persist } = await outcomeOf(claimOwner(depsFor({ users: [unclaimedOwner()], codes: [codeRow()] }), input));
    const [, codeUpdate, sessionInsert] = persist as Array<Persistable & { model: Record<string, unknown> }>;
    expect(codeUpdate?.model['usedAt']).toBe(NOW.toISOString());
    expect(sessionInsert?.model['tokenHash']).toBe('sha(TOKEN)');
    expect(JSON.stringify(persist)).not.toContain('"TOKEN"');
    expect(JSON.stringify(persist)).not.toContain(PASSWORD);
  });

  it.each([
    ['an unknown code', []],
    ['an expired code', [codeRow({ expiresAt: NOW.toISOString() })]],
    ['a used code', [codeRow({ usedAt: NOW.toISOString() })]],
  ])('rejects %s with the one indistinguishable error', async (_label, codes) => {
    const error = await errorOf(claimOwner(depsFor({ users: [unclaimedOwner()], codes }), input));
    expect(error).toEqual(authErrors.invalidSetupCode);
  });

  it('rejects any attempt once the owner is claimed, even with a valid code', async () => {
    const error = await errorOf(claimOwner(depsFor({ users: [claimedOwner()], codes: [codeRow()] }), input));
    expect(error).toEqual(authErrors.setupUnavailable);
  });

  it('rejects when the owner row is missing rather than creating one', async () => {
    const error = await errorOf(claimOwner(depsFor({ codes: [codeRow()] }), input));
    expect(error).toEqual(authErrors.setupUnavailable);
  });

  it('does not hash the password before the code checks out', async () => {
    const hashPassword = vi.spyOn(secrets, 'hashPassword');
    await errorOf(claimOwner(depsFor({ users: [unclaimedOwner()] }), input));
    expect(hashPassword).not.toHaveBeenCalled();
    hashPassword.mockRestore();
  });
});

describe('login', () => {
  const credentials = { username: 'rafael', password: PASSWORD };

  it('starts a session for the right credentials ', async () => {
    const { persist, response } = await outcomeOf(login(depsFor({ users: [claimedOwner()] }), credentials));
    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.insert}:${SESSION_ENTITY_TAG}`,
    ]);
    expect((persist[0] as Persistable & { model: unknown }).model).toMatchObject({
      id: OWNER_USER_ID,
      lastLoginAt: NOW.toISOString(),
    });
    expect(response.token).toBe('TOKEN');
    expect(JSON.stringify(persist)).not.toContain('"TOKEN"');
  });

  it('prunes expired sessions in the same batch', async () => {
    const expired = sessionRow({ id: 'old', expiresAt: NOW.toISOString() });
    const { persist } = await outcomeOf(login(depsFor({ users: [claimedOwner()], sessions: [expired] }), credentials));
    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.insert}:${SESSION_ENTITY_TAG}`,
    ]);
  });

  it.each([
    ['a wrong password', [claimedOwner()], { username: 'rafael', password: 'wrong wrong wrong' }],
    ['an unknown user', [claimedOwner()], { username: 'nobody', password: PASSWORD }],
    ['the unclaimed owner', [unclaimedOwner()], { username: 'rafael', password: PASSWORD }],
    ['a disabled user', [claimedOwner({ disabledAt: NOW.toISOString() })], credentials],
  ])('fails %s with the same generic error', async (_label, users, attempt) => {
    expect(await errorOf(login(depsFor({ users }), attempt))).toEqual(authErrors.invalidCredentials);
  });

  it('verifies against the dummy hash for an unknown user, so it costs the same as a wrong password', async () => {
    const verifyPassword = vi.spyOn(secrets, 'verifyPassword');
    await errorOf(login(depsFor({ users: [claimedOwner()] }), { username: 'nobody', password: PASSWORD }));
    expect(verifyPassword).toHaveBeenCalledWith(secrets.dummyPasswordHash, PASSWORD);
    verifyPassword.mockClear();
    await errorOf(login(depsFor({ users: [unclaimedOwner()] }), { username: 'rafael', password: PASSWORD }));
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    verifyPassword.mockRestore();
  });
});

describe('logout', () => {
  it('deletes the session row', async () => {
    const { persist } = await outcomeOf(logout(depsFor({ sessions: [sessionRow()] }), 'sha(TOKEN)'));
    expect(persist).toEqual([{ op: PersistOp.enum.delete, entity: SESSION_ENTITY_TAG, id: 's1', version: 0 }]);
  });

  it('is a no-op for an unknown token', async () => {
    const { persist } = await outcomeOf(logout(depsFor(), 'sha(nothing)'));
    expect(persist).toEqual([]);
  });
});

describe('authenticate', () => {
  const users = [claimedOwner()];

  it('resolves the principal without writing while the session is fresh', async () => {
    const { persist, response } = await outcomeOf(
      authenticate(depsFor({ users, sessions: [sessionRow()] }), 'sha(TOKEN)'),
    );
    expect(persist).toEqual([]);
    expect(response).toEqual({
      userId: OWNER_USER_ID,
      role: UserRole.enum.admin,
      scopes: [...ALL_SCOPES],
      via: PrincipalVia.enum.session,
    });
  });

  it('slides a stale session forward with a version-guarded update', async () => {
    const later = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS);
    const { persist, response } = await outcomeOf(
      authenticate(depsFor({ users, sessions: [sessionRow()], now: later }), 'sha(TOKEN)'),
    );
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.update}:${SESSION_ENTITY_TAG}`]);
    expect((persist[0] as { model: SessionEntity }).model).toMatchObject({
      lastSeenAt: later.toISOString(),
      version: 0,
    });
    expect(response?.userId).toBe(OWNER_USER_ID);
  });

  it('deletes an expired session and answers unauthenticated', async () => {
    const expired = sessionRow({ expiresAt: NOW.toISOString() });
    const { persist, response } = await outcomeOf(authenticate(depsFor({ users, sessions: [expired] }), 'sha(TOKEN)'));
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`]);
    expect(response).toBeNull();
  });

  it('deletes the session of a user who can no longer log in', async () => {
    const disabled = [claimedOwner({ disabledAt: NOW.toISOString() })];
    const { persist, response } = await outcomeOf(
      authenticate(depsFor({ users: disabled, sessions: [sessionRow()] }), 'sha(TOKEN)'),
    );
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`]);
    expect(response).toBeNull();
  });

  it('answers unauthenticated, writing nothing, for an unknown token', async () => {
    const { persist, response } = await outcomeOf(authenticate(depsFor({ users }), 'sha(guess)'));
    expect(persist).toEqual([]);
    expect(response).toBeNull();
  });
});

describe('pruneExpiredSessions', () => {
  it('deletes only the expired rows and reports how many', async () => {
    const sessions = [
      sessionRow({ id: 'old', expiresAt: NOW.toISOString() }),
      sessionRow({ id: 'live', tokenHash: 'x' }),
    ];
    const { persist, response } = await outcomeOf(pruneExpiredSessions(depsFor({ sessions })));
    expect(persist).toEqual([{ op: PersistOp.enum.delete, entity: SESSION_ENTITY_TAG, id: 'old', version: 0 }]);
    expect(response).toBe(1);
  });
});

describe('ownerNeedsSetup', () => {
  it('is true until the owner has credentials', async () => {
    expect(await ownerNeedsSetup(depsFor({ users: [unclaimedOwner()] }))).toBe(true);
    expect(await ownerNeedsSetup(depsFor({ users: [claimedOwner()] }))).toBe(false);
  });
});

const OTHER_USER_ID = 'user-other';
const otherUser = (): UserEntity => claimedOwner({ id: OTHER_USER_ID, username: 'ana', version: 3 });

const tokenRow = (overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id: 't1',
  userId: OWNER_USER_ID,
  kind: AccessTokenKind.enum.pat,
  clientName: null,
  profile: null,
  name: 'laptop',
  tokenHash: 'sha(ftk_T1)',
  prefix: 'ftk_T1',
  scopes: ['fintrack:read'],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  version: 2,
  ...overrides,
});

describe('claimOwnerLocally (ADR-034 §5)', () => {
  const input = { username: 'rafael', password: PASSWORD };

  it('refuses a username another user holds, for a first claim and for recovering a reissued owner', async () => {
    const other: UserEntity = { ...claimedOwner({ id: 'u-ana', role: UserRole.enum.member }), username: 'rafael' };
    expect(await errorOf(claimOwnerLocally(depsFor({ users: [unclaimedOwner(), other] }), input))).toEqual(
      authErrors.usernameTaken('rafael'),
    );
    const reissued = claimedOwner({ username: 'owner-name', passwordHash: null });
    expect(await errorOf(claimOwnerLocally(depsFor({ users: [reissued, other] }), input))).toEqual(
      authErrors.usernameTaken('rafael'),
    );
  });

  it('lets a reissued owner take back their own name', async () => {
    const reissued = claimedOwner({ passwordHash: null });
    expect((await claimOwnerLocally(depsFor({ users: [reissued] }), input)).isOk()).toBe(true);
  });

  it('updates the EXISTING owner — same id, no new user row, no session — and reports only the username', async () => {
    const { persist, response } = await outcomeOf(claimOwnerLocally(depsFor({ users: [unclaimedOwner()] }), input));

    expect(opsOf(persist)).toEqual([`${PersistOp.enum.update}:${USER_ENTITY_TAG}`]);
    const [userUpdate] = persist as Array<Persistable & { model: UserEntity }>;
    expect(userUpdate?.model).toMatchObject({
      id: OWNER_USER_ID,
      username: 'rafael',
      passwordHash: fakeHash(PASSWORD),
      version: 0,
    });
    expect(persist.some((p) => p.entity === SESSION_ENTITY_TAG)).toBe(false);
    expect(response).toEqual({ username: 'rafael' });
  });

  it('needs no setup code and stores the password only as a hash', async () => {
    const { persist, response } = await outcomeOf(claimOwnerLocally(depsFor({ users: [unclaimedOwner()] }), input));
    expect(JSON.stringify(persist)).not.toContain(PASSWORD);
    expect(JSON.stringify(response)).not.toContain(PASSWORD);
  });

  it('spends an outstanding setup code in the same batch, so it cannot claim afterwards', async () => {
    const { persist } = await outcomeOf(
      claimOwnerLocally(depsFor({ users: [unclaimedOwner()], codes: [codeRow({ version: 4 })] }), input),
    );
    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${SETUP_CODE_ENTITY_TAG}`,
    ]);
    const [, codeUpdate] = persist as Array<Persistable & { model: SetupCodeEntity }>;
    expect(codeUpdate?.model).toMatchObject({ id: SETUP_CODE_ID, usedAt: NOW.toISOString(), version: 4 });
  });

  it('leaves an already-spent setup code alone', async () => {
    const spent = codeRow({ usedAt: new Date(NOW.getTime() - 1).toISOString() });
    const { persist } = await outcomeOf(
      claimOwnerLocally(depsFor({ users: [unclaimedOwner()], codes: [spent] }), input),
    );
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.update}:${USER_ENTITY_TAG}`]);
  });

  it('rejects an owner somebody already claimed, writing nothing', async () => {
    const error = await errorOf(claimOwnerLocally(depsFor({ users: [claimedOwner()] }), input));
    expect(error).toEqual(authErrors.setupUnavailable);
  });

  it('rejects when the owner row is missing rather than creating one', async () => {
    expect(await errorOf(claimOwnerLocally(depsFor(), input))).toEqual(authErrors.setupUnavailable);
  });

  it('does not hash the password for an owner it will refuse', async () => {
    const hashPassword = vi.spyOn(secrets, 'hashPassword');
    await errorOf(claimOwnerLocally(depsFor({ users: [claimedOwner()] }), input));
    expect(hashPassword).not.toHaveBeenCalled();
    hashPassword.mockRestore();
  });
});

describe('resetPassword (ADR-034 §5)', () => {
  const NEW_PASSWORD = 'a brand new passphrase';

  it('changes the hash, ends the user’s sessions and revokes their live tokens in one batch', async () => {
    const deps = depsFor({
      users: [claimedOwner()],
      sessions: [sessionRow({ id: 's1' }), sessionRow({ id: 's2', tokenHash: 'sha(OTHER)' })],
      tokens: [
        tokenRow({ id: 't1' }),
        tokenRow({ id: 't2', tokenHash: 'sha(ftk_T2)', expiresAt: '2030-01-01T00:00:00.000Z' }),
      ],
    });
    const { persist, response } = await outcomeOf(resetPassword(deps, { password: NEW_PASSWORD }));

    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${ACCESS_TOKEN_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${ACCESS_TOKEN_ENTITY_TAG}`,
    ]);
    const [userUpdate, , , tokenUpdate] = persist as Array<Persistable & { model: Record<string, unknown> }>;
    expect(userUpdate?.model).toMatchObject({
      id: OWNER_USER_ID,
      username: 'rafael',
      passwordHash: fakeHash(NEW_PASSWORD),
    });
    expect(tokenUpdate?.model).toMatchObject({ id: 't1', revokedAt: NOW.toISOString(), version: 2 });
    expect(response).toEqual({ username: 'rafael', sessionsEnded: 2, tokensRevoked: 2 });
    expect(JSON.stringify(persist)).not.toContain(NEW_PASSWORD);
  });

  it('touches nobody else: another user’s sessions and tokens stay out of the batch', async () => {
    const deps = depsFor({
      users: [claimedOwner(), otherUser()],
      sessions: [sessionRow({ id: 'mine' }), sessionRow({ id: 'theirs', userId: OTHER_USER_ID, tokenHash: 'sha(X)' })],
      tokens: [tokenRow({ id: 'mine' }), tokenRow({ id: 'theirs', userId: OTHER_USER_ID, tokenHash: 'sha(ftk_X)' })],
    });
    const { persist, response } = await outcomeOf(resetPassword(deps, { password: NEW_PASSWORD }));

    const touchedIds = (persist as Array<Persistable & { model?: { id: string }; id?: string }>).map(
      (p) => p.model?.id ?? p.id,
    );
    expect(touchedIds).toEqual([OWNER_USER_ID, 'mine', 'mine']);
    expect(response).toMatchObject({ sessionsEnded: 1, tokensRevoked: 1 });
  });

  it('resets the named user, not the owner', async () => {
    const deps = depsFor({ users: [claimedOwner(), otherUser()] });
    const { persist, response } = await outcomeOf(resetPassword(deps, { username: 'ana', password: NEW_PASSWORD }));
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({
      model: { id: OTHER_USER_ID, username: 'ana', passwordHash: fakeHash(NEW_PASSWORD), version: 3 },
    });
    expect(response.username).toBe('ana');
  });

  it('leaves an already-expired token alone: it is not live, so it is neither revoked nor counted', async () => {
    const expired = tokenRow({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    const live = tokenRow({ id: 't2', tokenHash: 'sha(ftk_T2)', expiresAt: new Date(NOW.getTime() + 1).toISOString() });
    const { persist, response } = await outcomeOf(
      resetPassword(depsFor({ users: [claimedOwner()], tokens: [expired, live] }), { password: NEW_PASSWORD }),
    );
    const revokedIds = (persist as Array<Persistable & { model: { id: string } }>)
      .filter((p) => p.entity === ACCESS_TOKEN_ENTITY_TAG)
      .map((p) => p.model.id);
    expect(revokedIds).toEqual(['t2']);
    expect(response.tokensRevoked).toBe(1);
  });

  it('keeps already-revoked tokens as they are and does not count them', async () => {
    const revoked = tokenRow({ revokedAt: '2026-10-01T00:00:00.000Z' });
    const { persist, response } = await outcomeOf(
      resetPassword(depsFor({ users: [claimedOwner()], tokens: [revoked] }), { password: NEW_PASSWORD }),
    );
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.update}:${USER_ENTITY_TAG}`]);
    expect(response.tokensRevoked).toBe(0);
  });

  it('answers unknown_user for a name nobody holds, writing nothing', async () => {
    const error = await errorOf(
      resetPassword(depsFor({ users: [claimedOwner()] }), { username: 'nobody', password: NEW_PASSWORD }),
    );
    expect(error).toEqual(authErrors.unknownUser('nobody'));
  });

  it.each([
    ['an unclaimed owner', [unclaimedOwner()]],
    ['no owner row', []],
  ])('points the default target at `auth setup` when there is %s', async (_label, users) => {
    expect(await errorOf(resetPassword(depsFor({ users }), { password: NEW_PASSWORD }))).toEqual(
      authErrors.ownerUnclaimed,
    );
  });

  it('does not hash a password for a user it cannot find', async () => {
    const hashPassword = vi.spyOn(secrets, 'hashPassword');
    await errorOf(resetPassword(depsFor(), { username: 'nobody', password: NEW_PASSWORD }));
    expect(hashPassword).not.toHaveBeenCalled();
    hashPassword.mockRestore();
  });
});

describe('findResetTarget', () => {
  it('resolves the owner by default and a named user by username', async () => {
    const deps = depsFor({ users: [claimedOwner(), otherUser()] });
    expect((await findResetTarget(deps, undefined))._unsafeUnwrap().id).toBe(OWNER_USER_ID);
    expect((await findResetTarget(deps, 'ana'))._unsafeUnwrap().id).toBe(OTHER_USER_ID);
  });
});

describe('claimedOwnerOf', () => {
  it('names the owner once claimed and is null before', async () => {
    expect(await claimedOwnerOf(depsFor({ users: [unclaimedOwner()] }))).toBeNull();
    expect(await claimedOwnerOf(depsFor())).toBeNull();
    expect(await claimedOwnerOf(depsFor({ users: [claimedOwner()] }))).toEqual({ username: 'rafael' });
  });
});

describe('ownerClaimPlan', () => {
  it('claims while nobody holds the login, and skips an owner who already does', async () => {
    expect(await ownerClaimPlan(depsFor({ users: [unclaimedOwner()] }))).toEqual({ kind: 'claim' });
    expect(await ownerClaimPlan(depsFor({ users: [claimedOwner()] }))).toEqual({ kind: 'skip', username: 'rafael' });
  });
});

describe('claimRaceWinnerOf', () => {
  it('names the owner who won the race when the claim was refused as already taken', async () => {
    const deps = depsFor({ users: [claimedOwner()] });
    expect(await claimRaceWinnerOf(deps, authErrors.setupUnavailable)).toEqual({ username: 'rafael' });
  });

  it('names nobody for any other refusal', async () => {
    const deps = depsFor({ users: [claimedOwner()] });
    expect(await claimRaceWinnerOf(deps, authErrors.invalidSetupCode)).toBeNull();
  });
});
