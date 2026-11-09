import { DEFAULT_SIGN_IN_CAP, INSTANCE_SETTINGS_ID } from '../../../src/models/auth/users.js';
import { InstanceKind } from '../../../src/models/instance.js';
import { type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import type { ResultAsync } from 'neverthrow';
import type { AppError } from '../../../src/common/errors.js';
import type { AuthDeps, AuthSecrets } from '../../../src/controllers/deps.js';
import {
  OWNER_USER_ID,
  SETUP_CODE_ID,
  SETUP_CODE_TTL_MS,
  type SetupCodeEntity,
  type UserEntity,
  UserRole,
} from '../../../src/models/auth/owner.js';
import { SESSION_IDLE_TTL_MS, type SessionEntity } from '../../../src/models/auth/session.js';
import { type AccessTokenEntity, AccessTokenKind } from '../../../src/models/auth/token.js';

export const NOW = new Date('2026-10-07T12:00:00.000Z');
export const PASSWORD = 'correct horse battery staple';

// A stand-in that is deterministic but does not embed the plaintext, so "never stored" is assertable.
export const fakeHash = (password: string): string => `hash:${Buffer.from(password).toString('base64')}`;

export const secrets: AuthSecrets = {
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

export const unclaimedOwner = (): UserEntity => ({
  id: OWNER_USER_ID,
  username: null,
  passwordHash: null,
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  lastLoginAt: null,
  credentialsChangedAt: null,
  version: 0,
});
export const claimedOwner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  ...unclaimedOwner(),
  username: 'rafael',
  passwordHash: fakeHash(PASSWORD),
  version: 1,
  ...overrides,
});

export type World = {
  users?: UserEntity[];
  sessions?: SessionEntity[];
  codes?: SetupCodeEntity[];
  tokens?: AccessTokenEntity[];
  now?: Date;
};

export const depsFor = ({ users = [], sessions = [], codes = [], tokens = [], now = NOW }: World = {}): AuthDeps => {
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
      get: async () => ({
        id: INSTANCE_SETTINGS_ID,
        maxSignInDuration: DEFAULT_SIGN_IN_CAP,
        instanceKind: InstanceKind.enum.standard,
        demoSeededAt: null,
        demoCountry: null,
        version: 0,
      }),
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
export const outcomeOf = async <T>(
  result: ResultAsync<FlowOutcome<T>, AppError>,
): Promise<{ persist: Persistable[]; response: T }> => {
  const { persist, response } = (await result)._unsafeUnwrap();
  if (typeof response === 'function') throw new Error('expected a plain response');
  return { persist, response };
};
export const errorOf = async <T>(result: ResultAsync<T, AppError>): Promise<AppError> =>
  (await result)._unsafeUnwrapErr();

export const opsOf = (persist: Persistable[]) => persist.map(({ op, entity }) => `${op}:${entity}`);

export const sessionRow = (overrides: Partial<SessionEntity> = {}): SessionEntity => ({
  id: 's1',
  userId: OWNER_USER_ID,
  tokenHash: 'sha(TOKEN)',
  createdAt: NOW.toISOString(),
  lastSeenAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + SESSION_IDLE_TTL_MS).toISOString(),
  version: 0,
  ...overrides,
});

export const codeRow = (overrides: Partial<SetupCodeEntity> = {}): SetupCodeEntity => ({
  id: SETUP_CODE_ID,
  codeHash: 'sha(ABCDEFGHJKMNPQRSTVWX)',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + SETUP_CODE_TTL_MS).toISOString(),
  usedAt: null,
  version: 0,
  ...overrides,
});

export const OTHER_USER_ID = 'user-other';
export const otherUser = (): UserEntity => claimedOwner({ id: OTHER_USER_ID, username: 'ana', version: 3 });

export const tokenRow = (overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id: 't1',
  userId: OWNER_USER_ID,
  kind: AccessTokenKind.enum.pat,
  clientName: null,
  profile: null,
  name: 'laptop',
  tokenHash: 'sha(ptk_T1)',
  prefix: 'ptk_T1',
  scopes: ['patty:read'],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  version: 2,
  ...overrides,
});
