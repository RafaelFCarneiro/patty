import { PersistOp, type Persistable } from '@rfc0/effect-runner';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_ENTITY_TAG, USER_ENTITY_TAG } from '../../../../src/models/auth/entity.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { OWNER_USER_ID, UserRole } from '../../../../src/models/auth/owner.js';
import { PrincipalVia } from '../../../../src/models/auth/principal.js';
import { DAY_MS } from '../../../../src/models/auth/time.js';
import { ALL_SCOPES } from '../../../../src/models/auth/scope.js';
import { SESSION_TOUCH_INTERVAL_MS, type SessionEntity } from '../../../../src/models/auth/session.js';
import { authenticate, login, logout, pruneExpiredSessions } from '../../../../src/controllers/auth/session.js';
import {
  NOW,
  PASSWORD,
  secrets,
  unclaimedOwner,
  claimedOwner,
  depsFor,
  outcomeOf,
  errorOf,
  opsOf,
  sessionRow,
} from '../../fixtures/auth-world.js';

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
      credentialsChangedAt: NOW.toISOString(),
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
      sessionId: sessionRow().id,
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

  it('deletes a session not seen for just over 24 hours, and slides one seen within it', async () => {
    const idle = (ms: number) => new Date(NOW.getTime() + ms);
    const expired = await outcomeOf(
      authenticate(depsFor({ users, sessions: [sessionRow()], now: idle(DAY_MS + 1) }), 'sha(TOKEN)'),
    );
    expect(opsOf(expired.persist)).toEqual([`${PersistOp.enum.delete}:${SESSION_ENTITY_TAG}`]);
    expect(expired.response).toBeNull();

    const seen = idle(DAY_MS - 1);
    const slid = await outcomeOf(authenticate(depsFor({ users, sessions: [sessionRow()], now: seen }), 'sha(TOKEN)'));
    expect(opsOf(slid.persist)).toEqual([`${PersistOp.enum.update}:${SESSION_ENTITY_TAG}`]);
    expect((slid.persist[0] as { model: SessionEntity }).model.expiresAt).toBe(
      new Date(seen.getTime() + DAY_MS).toISOString(),
    );
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
