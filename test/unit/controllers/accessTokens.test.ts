import { PersistOp, type FlowOutcome, type Persistable } from '@rfc0/effect-runner';
import type { ResultAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import type { AppError } from '../../../src/common/errors.js';
import { authenticateToken, createToken, listTokens, revokeToken } from '../../../src/controllers/accessTokens.js';
import type { AuthDeps, AuthSecrets } from '../../../src/controllers/deps.js';
import {
  ACCESS_TOKEN_ENTITY_TAG,
  authErrors,
  OWNER_USER_ID,
  PrincipalVia,
  Scope,
  UserRole,
  type AccessTokenEntity,
  type UserEntity,
  SESSION_TOUCH_INTERVAL_MS,
} from '../../../src/models/auth.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const READ = Scope.enum['fintrack:read'];
const WRITE = Scope.enum['fintrack:write'];
const PLAINTEXT = 'ftk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefg';

// Deterministic, and it does not embed the plaintext, so "the hash is stored, not the token" is assertable.
const fakeHash = (secret: string): string => `sha:${Buffer.from(secret).toString('base64')}`;
const PASSWORD = 'correct horse battery staple';
const secrets = {
  randomAccessToken: () => PLAINTEXT,
  hashSecret: fakeHash,
  verifyPassword: async (hash: string, password: string) => hash === fakeHash(password),
  dummyPasswordHash: fakeHash('never-typed'),
} as unknown as AuthSecrets;

const claimedOwner = (overrides: Partial<UserEntity> = {}): UserEntity => ({
  id: OWNER_USER_ID,
  username: 'rafael',
  passwordHash: fakeHash(PASSWORD),
  role: UserRole.enum.admin,
  createdAt: NOW.toISOString(),
  disabledAt: null,
  version: 1,
  ...overrides,
});

const tokenRow = (overrides: Partial<AccessTokenEntity> = {}): AccessTokenEntity => ({
  id: 't1',
  userId: OWNER_USER_ID,
  name: 'laptop',
  tokenHash: fakeHash(PLAINTEXT),
  prefix: 'ftk_AbCdEf',
  scopes: [READ],
  createdAt: NOW.toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  version: 0,
  ...overrides,
});

type World = { users?: UserEntity[]; tokens?: AccessTokenEntity[]; now?: Date };

const depsFor = ({ users = [claimedOwner()], tokens = [], now = NOW }: World = {}): AuthDeps =>
  ({
    users: { findById: async (id: string) => users.find((user) => user.id === id) ?? null },
    accessTokens: {
      findByTokenHash: async (hash: string) => tokens.find((token) => token.tokenHash === hash) ?? null,
      findById: async (userId: string, id: string) =>
        tokens.find((token) => token.id === id && token.userId === userId) ?? null,
      listByUser: async (userId: string) => tokens.filter((token) => token.userId === userId),
    },
    clock: () => now,
    newId: () => 'new-id',
    secrets,
  }) as unknown as AuthDeps;

const outcomeOf = async <T>(
  result: ResultAsync<FlowOutcome<T>, AppError>,
): Promise<{ persist: Persistable[]; response: T }> => {
  const { persist, response } = (await result)._unsafeUnwrap();
  if (typeof response === 'function') throw new Error('expected a plain response');
  return { persist, response };
};

describe('createToken', () => {
  const input = { name: 'laptop', access: 'write', expiry: '90', password: PASSWORD } as const;

  it('returns the plaintext once and persists only its hash and a display prefix', async () => {
    const { persist, response } = await outcomeOf(createToken(depsFor(), OWNER_USER_ID, input));

    expect(response.token).toBe(PLAINTEXT);
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.insert, entity: ACCESS_TOKEN_ENTITY_TAG });
    const stored = (persist[0] as { model: Record<string, unknown> }).model;
    expect(stored).toMatchObject({
      id: 'new-id',
      userId: OWNER_USER_ID,
      name: 'laptop',
      tokenHash: fakeHash(PLAINTEXT),
      prefix: 'ftk_AbCdEf',
      scopes: [READ, WRITE],
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(persist)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(response.summary)).not.toContain(PLAINTEXT);
    expect(response.summary).toMatchObject({ id: 'new-id', status: 'active', prefix: 'ftk_AbCdEf' });
  });

  it('gives a read-only token only the read scope, and every new token an expiry', async () => {
    const { persist } = await outcomeOf(
      createToken(depsFor(), OWNER_USER_ID, { name: 'ro', access: 'read', expiry: '30', password: PASSWORD }),
    );
    const thirtyDays = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect((persist[0] as { model: AccessTokenEntity }).model).toMatchObject({
      scopes: [READ],
      expiresAt: thirtyDays,
    });
  });
});

describe('createToken — step-up password', () => {
  const spec = { name: 'laptop', access: 'write', expiry: '90' } as const;

  it.each([
    ['a wrong password', { users: [claimedOwner()] }, 'not the password'],
    ['an empty password', { users: [claimedOwner()] }, ''],
    ['a user without credentials', { users: [claimedOwner({ username: null, passwordHash: null })] }, PASSWORD],
    ['a disabled user', { users: [claimedOwner({ disabledAt: NOW.toISOString() })] }, PASSWORD],
    ['an unknown user', { users: [] }, PASSWORD],
  ] as const)('refuses %s and persists nothing', async (_label, world, password) => {
    const result = await createToken(depsFor(world as unknown as World), OWNER_USER_ID, { ...spec, password });
    expect(result._unsafeUnwrapErr()).toEqual(authErrors.invalidCredentials);
  });
});

describe('listTokens', () => {
  it('lists metadata only — never a hash — newest first as the repo returns them', async () => {
    const listed = await listTokens(
      depsFor({ tokens: [tokenRow(), tokenRow({ id: 't2', revokedAt: NOW.toISOString() })] }),
      OWNER_USER_ID,
    );
    expect(listed.map(({ id, status }) => [id, status])).toEqual([
      ['t1', 'active'],
      ['t2', 'revoked'],
    ]);
    expect(JSON.stringify(listed)).not.toContain('sha:');
    for (const summary of listed) expect(summary).not.toHaveProperty('tokenHash');
  });

  it('lists nothing for a user who has none', async () => {
    expect(await listTokens(depsFor({ tokens: [tokenRow()] }), 'someone-else')).toEqual([]);
  });
});

describe('revokeToken', () => {
  it('sets revoked_at with a version-guarded update and keeps the row', async () => {
    const { persist } = await outcomeOf(
      revokeToken(depsFor({ tokens: [tokenRow({ version: 4 })] }), OWNER_USER_ID, 't1'),
    );
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.update, entity: ACCESS_TOKEN_ENTITY_TAG });
    expect((persist[0] as { model: AccessTokenEntity }).model).toMatchObject({
      id: 't1',
      revokedAt: NOW.toISOString(),
      version: 4,
    });
  });

  it('is idempotent: revoking a revoked token writes nothing', async () => {
    const revoked = tokenRow({ revokedAt: '2026-10-01T00:00:00.000Z' });
    const { persist } = await outcomeOf(revokeToken(depsFor({ tokens: [revoked] }), OWNER_USER_ID, 't1'));
    expect(persist).toEqual([]);
  });

  it('reports an unknown token, and another user’s token reads as unknown', async () => {
    const deps = depsFor({ tokens: [tokenRow()] });
    expect((await revokeToken(deps, OWNER_USER_ID, 'nope'))._unsafeUnwrapErr()).toEqual(
      authErrors.unknownToken('nope'),
    );
    expect((await revokeToken(deps, 'someone-else', 't1'))._unsafeUnwrapErr()).toEqual(authErrors.unknownToken('t1'));
  });
});

describe('authenticateToken', () => {
  const hash = fakeHash(PLAINTEXT);

  it('resolves the principal with the token’s scopes', async () => {
    const { response } = await outcomeOf(
      authenticateToken(depsFor({ tokens: [tokenRow({ scopes: [READ], lastUsedAt: NOW.toISOString() })] }), hash),
    );
    expect(response).toEqual({
      userId: OWNER_USER_ID,
      role: UserRole.enum.admin,
      scopes: [READ],
      via: PrincipalVia.enum.token,
      tokenId: 't1',
    });
  });

  it('keeps authenticating a legacy token with no expiry, until it is revoked', async () => {
    const legacy = tokenRow({ expiresAt: null, lastUsedAt: NOW.toISOString() });
    const farFuture = new Date(NOW.getTime() + 20 * 365 * 24 * 60 * 60 * 1000);
    const { response } = await outcomeOf(authenticateToken(depsFor({ tokens: [legacy], now: farFuture }), hash));
    expect(response).toMatchObject({ via: PrincipalVia.enum.token, tokenId: 't1' });

    const revoked = tokenRow({ expiresAt: null, revokedAt: NOW.toISOString() });
    const { response: afterRevoke } = await outcomeOf(authenticateToken(depsFor({ tokens: [revoked] }), hash));
    expect(afterRevoke).toBeNull();
  });

  it('records first use, then throttles last_used_at like the session touch', async () => {
    const first = await outcomeOf(authenticateToken(depsFor({ tokens: [tokenRow()] }), hash));
    expect(first.persist).toHaveLength(1);
    expect((first.persist[0] as { model: AccessTokenEntity }).model).toMatchObject({
      lastUsedAt: NOW.toISOString(),
      version: 0,
    });

    const used = tokenRow({ lastUsedAt: NOW.toISOString() });
    const soon = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS - 1);
    const stale = new Date(NOW.getTime() + SESSION_TOUCH_INTERVAL_MS);
    expect((await outcomeOf(authenticateToken(depsFor({ tokens: [used], now: soon }), hash))).persist).toEqual([]);
    const touched = await outcomeOf(authenticateToken(depsFor({ tokens: [used], now: stale }), hash));
    expect(touched.persist).toHaveLength(1);
    expect((touched.persist[0] as { model: AccessTokenEntity }).model.lastUsedAt).toBe(stale.toISOString());
  });

  it.each([
    ['an unknown token', {}, fakeHash('ftk_other')],
    ['a revoked token', { tokens: [tokenRow({ revokedAt: NOW.toISOString() })] }, hash],
    ['an expired token', { tokens: [tokenRow({ expiresAt: NOW.toISOString() })] }, hash],
    [
      'a token whose owner is unclaimed',
      { tokens: [tokenRow()], users: [claimedOwner({ username: null, passwordHash: null })] },
      hash,
    ],
    ['a token whose owner is disabled', { tokens: [tokenRow()], users: [claimedOwner({ disabledAt: 'x' })] }, hash],
    ['a token whose owner is gone', { tokens: [tokenRow()], users: [] }, hash],
  ] as const)('answers null — and writes nothing — for %s', async (_label, world, lookup) => {
    const { persist, response } = await outcomeOf(authenticateToken(depsFor(world as World), lookup));
    expect(response).toBeNull();
    expect(persist).toEqual([]);
  });
});
