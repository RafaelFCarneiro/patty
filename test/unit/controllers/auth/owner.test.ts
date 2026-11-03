import { PersistOp, type Persistable } from '@rfc0/effect-runner';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_ENTITY_TAG, SETUP_CODE_ENTITY_TAG, USER_ENTITY_TAG } from '../../../../src/models/auth/entity.js';
import { authErrors } from '../../../../src/models/auth/errors.js';
import { AuthMode } from '../../../../src/models/auth/mode.js';
import {
  OWNER_USER_ID,
  SETUP_CODE_ID,
  SETUP_CODE_TTL_MS,
  type SetupCodeEntity,
  type UserEntity,
  UserRole,
} from '../../../../src/models/auth/owner.js';
import { SESSION_IDLE_TTL_MS } from '../../../../src/models/auth/session.js';
import {
  claimedOwnerOf,
  claimOwner,
  claimOwnerLocally,
  claimRaceWinnerOf,
  issueSetupCode,
  ownerClaimPlan,
  ownerNeedsSetup,
} from '../../../../src/controllers/auth/owner.js';
import {
  NOW,
  PASSWORD,
  fakeHash,
  secrets,
  unclaimedOwner,
  claimedOwner,
  depsFor,
  outcomeOf,
  errorOf,
  opsOf,
  codeRow,
} from '../../fixtures/auth-world.js';

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

describe('ownerNeedsSetup', () => {
  it('is true until the owner has credentials', async () => {
    expect(await ownerNeedsSetup(depsFor({ users: [unclaimedOwner()] }))).toBe(true);
    expect(await ownerNeedsSetup(depsFor({ users: [claimedOwner()] }))).toBe(false);
  });
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
