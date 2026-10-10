import { PersistOp, type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import type { ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../src/common/errors.js';
import {
  authenticate,
  claimOwner,
  issueSetupCode,
  login,
  logout,
  ownerNeedsSetup,
  pruneExpiredSessions,
} from '../../../src/controllers/auth.js';
import type { AuthDeps, AuthSecrets } from '../../../src/controllers/deps.js';
import { SESSION_IDLE_TTL_MS, SESSION_TOUCH_INTERVAL_MS, SETUP_CODE_TTL_MS } from '../../../src/logic/auth.js';
import {
  ALL_SCOPES,
  AuthMode,
  authErrors,
  PrincipalVia,
  OWNER_USER_ID,
  SESSION_ENTITY_TAG,
  SETUP_CODE_ENTITY_TAG,
  SETUP_CODE_ID,
  USER_ENTITY_TAG,
  UserRole,
  type SessionEntity,
  type SetupCodeEntity,
  type UserEntity,
} from '../../../src/models/auth.js';

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
  version: 0,
});
const claimedOwner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  ...unclaimedOwner(),
  username: 'rafael',
  passwordHash: fakeHash(PASSWORD),
  version: 1,
  ...overrides,
});

type World = { users?: UserEntity[]; sessions?: SessionEntity[]; codes?: SetupCodeEntity[]; now?: Date };

const depsFor = ({ users = [], sessions = [], codes = [], now = NOW }: World = {}): AuthDeps => {
  let ids = 0;
  return {
    users: {
      findById: async (id) => users.find((user) => user.id === id) ?? null,
      findByUsername: async (username) => users.find((user) => user.username === username) ?? null,
    },
    sessions: {
      findByTokenHash: async (hash) => sessions.find((session) => session.tokenHash === hash) ?? null,
      listExpired: async (nowIso) => sessions.filter((session) => session.expiresAt <= nowIso),
    },
    accessTokens: { findByTokenHash: async () => null, findById: async () => null, listByUser: async () => [] },
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
    expect(opsOf(persist)).toEqual([`${PersistOp.enum.insert}:${SESSION_ENTITY_TAG}`]);
    expect(response.token).toBe('TOKEN');
    expect(JSON.stringify(persist)).not.toContain('"TOKEN"');
  });

  it('prunes expired sessions in the same batch', async () => {
    const expired = sessionRow({ id: 'old', expiresAt: NOW.toISOString() });
    const { persist } = await outcomeOf(login(depsFor({ users: [claimedOwner()], sessions: [expired] }), credentials));
    expect(opsOf(persist)).toEqual([
      `${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`,
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
