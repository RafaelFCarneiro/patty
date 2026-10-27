import { PersistOp, type FlowOutcome } from '@rfc0/effect-runner';
import { InstanceKind } from '../../../src/models/instance.js';
import type { ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../src/common/errors.js';
import type { AuthDeps, AuthSecrets } from '../../../src/controllers/deps.js';
import { approveGrant } from '../../../src/controllers/grants.js';
import { CLIENT_GRANT_ENTITY_TAG, SESSION_ENTITY_TAG, USER_ENTITY_TAG } from '../../../src/models/auth/entity.js';
import { authErrors } from '../../../src/models/auth/errors.js';
import { type ClientGrantEntity, GrantChannel, GrantStatus, SignInDuration } from '../../../src/models/auth/grant.js';
import { OWNER_USER_ID, type UserEntity, UserRole } from '../../../src/models/auth/owner.js';
import { type Principal, PrincipalVia } from '../../../src/models/auth/principal.js';
import { Scope } from '../../../src/models/auth/scope.js';
import type { SessionEntity } from '../../../src/models/auth/session.js';
import { TokenAccess } from '../../../src/models/auth/token.js';
import { DEFAULT_SIGN_IN_CAP } from '../../../src/models/auth/users.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
const USER_CODE = 'ABCD2345';
const SESSION_ID = 's1';

const fakeHash = (secret: string): string => `sha:${Buffer.from(secret).toString('base64')}`;
const verifyPassword = vi.fn(async (hash: string, password: string) => hash === fakeHash(password));

const secrets = {
  verifyPassword,
  dummyPasswordHash: fakeHash('never-typed'),
} as unknown as AuthSecrets;

const claimedOwner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: 'rafael',
  passwordHash: fakeHash(PASSWORD),
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: null,
  version: 1,
  ...overrides,
});

const sessionRow = (): SessionEntity => ({
  id: SESSION_ID,
  userId: OWNER_USER_ID,
  tokenHash: 'sha(TOKEN)',
  createdAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  version: 4,
});

const pendingGrant = (): ClientGrantEntity => ({
  id: 'g1',
  deviceCodeHash: 'device-hash',
  userCode: USER_CODE,
  clientName: 'Claude Desktop',
  clientVersion: '1.2.3',
  profile: 'default',
  channel: GrantChannel.enum.stdio,
  hintAccess: null,
  hintDuration: null,
  status: GrantStatus.enum.pending,
  userId: null,
  scopes: null,
  duration: null,
  createdAt: NOW.toISOString(),
  approvedAt: null,
  expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  version: 0,
});

const SESSION_PRINCIPAL: Principal = {
  userId: OWNER_USER_ID,
  role: UserRole.enum.admin,
  scopes: [Scope.enum['fintrack:read'], Scope.enum['fintrack:write']],
  via: PrincipalVia.enum.session,
  sessionId: SESSION_ID,
};

const depsFor = (users: UserEntity[] = [claimedOwner()]): AuthDeps =>
  ({
    users: { findById: async (id: string) => users.find((user) => user.id === id) ?? null },
    sessions: { listByUser: async () => [sessionRow()] },
    clientGrants: { findPendingByUserCode: async () => pendingGrant() },
    instanceSettings: {
      get: async () => ({
        id: 'singleton',
        maxSignInDuration: DEFAULT_SIGN_IN_CAP,
        instanceKind: InstanceKind.enum.standard,
        demoSeededAt: null,
        demoCountry: null,
        version: 0,
      }),
    },
    clock: () => NOW,
    secrets,
  }) as unknown as AuthDeps;

const choice = { userCode: USER_CODE, access: TokenAccess.enum.write, duration: SignInDuration.enum['24h'] } as const;

const outcomeOf = async <T>(result: ResultAsync<FlowOutcome<T>, AppError>) => (await result)._unsafeUnwrap();

describe('approveGrant — step-up password', () => {
  it('approves with the right password, moving the approver’s credential epoch in the same batch', async () => {
    verifyPassword.mockClear();
    const { persist } = await outcomeOf(approveGrant(depsFor(), SESSION_PRINCIPAL, { ...choice, password: PASSWORD }));

    expect(verifyPassword).toHaveBeenCalledWith(fakeHash(PASSWORD), PASSWORD);
    expect(persist.map((effect) => `${effect.op}:${effect.entity}`)).toEqual([
      `${PersistOp.enum.check}:${SESSION_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${USER_ENTITY_TAG}`,
      `${PersistOp.enum.update}:${CLIENT_GRANT_ENTITY_TAG}`,
    ]);
    expect(persist[1]).toMatchObject({ model: { id: OWNER_USER_ID, credentialsChangedAt: NOW.toISOString() } });
    expect(persist[2]).toMatchObject({ model: { status: GrantStatus.enum.approved, userId: OWNER_USER_ID } });
  });

  it.each([
    ['a wrong password', 'not the password'],
    ['an empty password', ''],
    ['no password', undefined],
  ])('refuses %s with the generic step-up error, persisting nothing', async (_label, password) => {
    verifyPassword.mockClear();
    const result = await approveGrant(depsFor(), SESSION_PRINCIPAL, { ...choice, password });

    expect(result._unsafeUnwrapErr()).toEqual(authErrors.invalidCredentials);
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('refuses an approver who can no longer sign in, even with their password', async () => {
    const disabled = claimedOwner({ disabledAt: NOW.toISOString() });
    const result = await approveGrant(depsFor([disabled]), SESSION_PRINCIPAL, { ...choice, password: PASSWORD });

    expect(result._unsafeUnwrapErr()).toEqual(authErrors.unauthenticated);
  });
});
