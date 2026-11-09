import { PersistOp, type Persistable } from '@rfc0/effect-runner';
import { describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_ENTITY_TAG, SESSION_ENTITY_TAG, USER_ENTITY_TAG } from '../../../../src/models/auth/entity.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { OWNER_USER_ID } from '../../../../src/models/auth/owner.js';
import { findResetTarget, resetPassword } from '../../../../src/controllers/auth/password.js';
import {
  NOW,
  fakeHash,
  secrets,
  unclaimedOwner,
  claimedOwner,
  depsFor,
  outcomeOf,
  errorOf,
  opsOf,
  sessionRow,
  OTHER_USER_ID,
  otherUser,
  tokenRow,
} from '../../fixtures/auth-world.js';

describe('resetPassword (ADR-034 §5)', () => {
  const NEW_PASSWORD = 'a brand new passphrase';

  it('changes the hash, ends the user’s sessions and revokes their live tokens in one batch', async () => {
    const deps = depsFor({
      users: [claimedOwner()],
      sessions: [sessionRow({ id: 's1' }), sessionRow({ id: 's2', tokenHash: 'sha(OTHER)' })],
      tokens: [
        tokenRow({ id: 't1' }),
        tokenRow({ id: 't2', tokenHash: 'sha(ptk_T2)', expiresAt: '2030-01-01T00:00:00.000Z' }),
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
      tokens: [tokenRow({ id: 'mine' }), tokenRow({ id: 'theirs', userId: OTHER_USER_ID, tokenHash: 'sha(ptk_X)' })],
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
    const live = tokenRow({ id: 't2', tokenHash: 'sha(ptk_T2)', expiresAt: new Date(NOW.getTime() + 1).toISOString() });
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
