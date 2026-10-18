import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { createToken } from '../../../src/controllers/accessTokens.js';
import { approveGrant, redeemGrant, startGrant } from '../../../src/controllers/grants.js';
import { disableUser, inviteUser } from '../../../src/controllers/users.js';
import { UserRole } from '../../../src/models/auth/owner.js';
import { ActorKind, type Actor } from '../../../src/models/auth/users.js';
import { PrincipalVia, type Principal } from '../../../src/models/auth/principal.js';
import { ALL_SCOPES } from '../../../src/models/auth/scope.js';
import {
  authDepsOf,
  bearer,
  browserHeaders,
  claimOwner,
  formBody,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  mintToken,
  PASSWORD,
  sessionCookieOf,
  stdioSessionFor,
  useAuthApp,
  userCodeIn,
  approveConnect,
} from './helpers.js';
import {
  addUser,
  claim,
  get,
  invite,
  inviteRows,
  liveTokenCount,
  loginAs,
  MEMBER_PASSWORD,
  mintFor,
  mustClaim,
  mustInvite,
  post,
  userIdOf,
  userRow,
  userRows,
  USERS_URL,
  countRows,
} from './userHelpers.js';
import type { AppContext } from '../app-builder.js';

const createApp = useAuthApp();

const HOUR_MS = 60 * 60 * 1000;

/** An app with the owner claimed: the first admin, signed in. */
const withOwner = async () => {
  const ctx = await createApp();
  return { ctx, owner: await claimOwner(ctx) };
};

/** A stdio session signed in as the person behind `cookie`, the way they would be: ask, approve at /ui/connect. */
const stdioSignedIn = async (ctx: AppContext, cookie: string, choice: Parameters<typeof approveConnect>[3] = {}) => {
  const { session } = stdioSessionFor(ctx);
  await approveConnect(ctx, cookie, userCodeIn(await session.resolve()), choice);
  const outcome = await session.resolve();
  if (outcome.kind !== 'granted') throw new Error(`stdio sign-in did not complete: ${JSON.stringify(outcome)}`);
  return session;
};

describe('invite → claim → login (ADR-033 §5)', () => {
  it('lets an admin invite a person who then chooses their own password and lands signed in', async () => {
    const { ctx, owner } = await withOwner();

    const { res, code, link } = await invite(ctx, owner, { username: 'Ana' });
    expect(res.statusCode).toBe(200);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    expect(link).toBe(`${LOOPBACK_ORIGIN}/ui/invite?code=${code}`);

    // The unclaimed row exists with a username and role but no password; the invite stores only a hash.
    expect(await userRow(ctx, 'ana')).toMatchObject({ role: 'member', password_hash: null, disabled_at: null });
    const [stored] = await inviteRows(ctx);
    expect(stored).toMatchObject({ used_at: null });
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await inviteRows(ctx))).not.toContain(code.replaceAll('-', ''));
    expect(JSON.stringify(await ctx.db.all(sql`SELECT * FROM users`))).not.toContain(code);

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/ui/invite?code=${code}`,
      headers: { host: LOOPBACK_HOST },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`value="${code}"`);

    const claimed = await claim(ctx, code);
    expect(claimed.statusCode).toBe(303);
    expect(claimed.headers.location).toBe('/ui');
    const cookie = sessionCookieOf(claimed)!;
    expect(cookie).toBeDefined();
    expect((await get(ctx, cookie, '/ui/access/tokens')).statusCode).toBe(200);

    // Claiming UPDATED the row that existed: still two users, the password is an argon2id hash, the invite is spent.
    const rows = await userRows(ctx);
    expect(rows).toHaveLength(2);
    expect(await userRow(ctx, 'ana')).toMatchObject({ password_hash: expect.stringMatching(/^\$argon2id\$/) });
    expect((await userRow(ctx, 'ana'))?.last_login_at).not.toBeNull();
    expect((await inviteRows(ctx))[0]?.used_at).not.toBeNull();

    // And the password works at the ordinary login.
    const login = await loginAs(ctx, 'Ana');
    expect(login.statusCode).toBe(303);
    expect(sessionCookieOf(login)).toBeDefined();
  });

  it('gives an invited admin the user-management pages and an invited member none', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const ana = await addUser(ctx, owner, 'ana');

    expect((await get(ctx, boss.cookie, USERS_URL)).statusCode).toBe(200);
    expect((await get(ctx, ana.cookie, USERS_URL)).statusCode).toBe(404);
  });

  it('lists each user with role, status and last login', async () => {
    const { ctx, owner } = await withOwner();
    await mustInvite(ctx, owner, { username: 'bob' });
    await addUser(ctx, owner, 'ana');

    const page = (await get(ctx, owner, USERS_URL)).body;
    expect(page).toMatch(/data-user="rafael"[\s\S]*?admin[\s\S]*?active/);
    expect(page).toMatch(/data-user="ana"[\s\S]*?member[\s\S]*?active/);
    expect(page).toMatch(/data-user="bob"[\s\S]*?invited \(expires /);
  });

  it('spends an invite on its first use: a second claim is refused and changes no password', async () => {
    const { ctx, owner } = await withOwner();
    const code = await mustInvite(ctx, owner, { username: 'ana' });
    await mustClaim(ctx, code);
    const before = await userRow(ctx, 'ana');

    const again = await claim(ctx, code, 'a different passphrase');

    expect(again.statusCode).toBe(403);
    expect(sessionCookieOf(again)).toBeUndefined();
    expect(await userRow(ctx, 'ana')).toEqual(before);
    expect((await loginAs(ctx, 'ana', 'a different passphrase')).statusCode).toBe(401);
  });

  it('refuses an expired invite, and a foreign or mistyped code, with the very same page', async () => {
    const { ctx, owner } = await withOwner();
    const expired = await mustInvite(ctx, owner, { username: 'late' });
    await ctx.db.run(sql`UPDATE invites SET expires_at = ${new Date(Date.now() - HOUR_MS).toISOString()}`);

    const refusals = [
      await claim(ctx, expired),
      await claim(ctx, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ'),
      await claim(ctx, expired.slice(0, -1) + (expired.endsWith('0') ? '1' : '0')),
    ];

    for (const refusal of refusals) {
      expect(refusal.statusCode).toBe(403);
      expect(sessionCookieOf(refusal)).toBeUndefined();
      expect(refusal.body).toContain('not valid, has expired, or was already used');
    }
    expect(new Set(refusals.map((r) => r.body.replace(/value="[^"]*"/, '')))).toHaveProperty('size', 1);
    expect((await userRow(ctx, 'late'))?.password_hash).toBeNull();
  });

  it('refuses an invite whose user has been disabled', async () => {
    const { ctx, owner } = await withOwner();
    const code = await mustInvite(ctx, owner, { username: 'ana' });
    await post(ctx, owner, `${USERS_URL}/${await userIdOf(ctx, 'ana')}/disable`, { password: PASSWORD });

    expect((await claim(ctx, code)).statusCode).toBe(403);
  });

  it('keeps usernames unique, case-insensitively, for the owner, the invited and the disabled alike', async () => {
    const { ctx, owner } = await withOwner();
    await mustInvite(ctx, owner, { username: 'ana' });

    for (const taken of ['ana', 'ANA', 'Rafael', ' ana ']) {
      const { res } = await invite(ctx, owner, { username: taken });
      expect(res.statusCode, taken).toBe(409);
      expect(res.body).toContain('already taken');
    }
    expect(await userRows(ctx)).toHaveLength(2);
  });

  it('sets a username and a password under the same rules as setup', async () => {
    const { ctx, owner } = await withOwner();
    expect((await invite(ctx, owner, { username: 'ab' })).res.statusCode).toBe(422);
    const code = await mustInvite(ctx, owner, { username: 'ana' });

    const tooShort = await claim(ctx, code, 'short');

    expect(tooShort.statusCode).toBe(422);
    expect((await userRow(ctx, 'ana'))?.password_hash).toBeNull();
    // The invite survives a rejected password.
    expect((await claim(ctx, code)).statusCode).toBe(303);
  });

  it('throttles guesses at one invite code like guesses at the setup code', async () => {
    const { ctx } = await withOwner();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await claim(ctx, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')).statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('step-up: the admin’s password is asked again', () => {
  it('refuses an invite with a wrong or missing password and creates nobody', async () => {
    const { ctx, owner } = await withOwner();

    const wrong = await invite(ctx, owner, { username: 'ana', password: 'not the password' });
    const missing = await post(ctx, owner, USERS_URL, { username: 'ana', role: 'member' });

    expect(wrong.res.statusCode).toBe(403);
    expect(wrong.code).toBe('');
    expect(missing.statusCode).toBe(422);
    expect(await userRows(ctx)).toHaveLength(1);
    expect(await inviteRows(ctx)).toEqual([]);
  });

  it('asks again for reissue, disable, enable, role and the sign-in cap', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const id = ana.userId;
    const attempts: Array<[string, Record<string, string>]> = [
      [`${USERS_URL}/${id}/reissue`, {}],
      [`${USERS_URL}/${id}/disable`, {}],
      [`${USERS_URL}/${id}/enable`, {}],
      [`${USERS_URL}/${id}/role`, { role: 'admin' }],
      [`${USERS_URL}/sign-in-cap`, { maxSignInDuration: '24h' }],
    ];
    for (const [url, fields] of attempts) {
      const wrong = await post(ctx, owner, url, { ...fields, password: 'not the password' });
      expect(wrong.statusCode, url).toBe(403);
      const none = await post(ctx, owner, url, fields);
      expect(none.statusCode, url).toBe(422);
    }

    expect(await userRow(ctx, 'ana')).toMatchObject({ role: 'member', disabled_at: null });
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).statusCode).toBe(200);
    expect(await ctx.db.all(sql`SELECT * FROM settings`)).toEqual([]);
  });

  it('leaves a disabled user disabled when the password typed to enable them is wrong', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });

    const wrong = await post(ctx, owner, `${USERS_URL}/${ana.userId}/enable`, { password: 'not the password' });

    expect(wrong.statusCode).toBe(403);
    expect(await userRow(ctx, 'ana')).toMatchObject({ disabled_at: expect.any(String) });
    expect((await loginAs(ctx, 'ana')).statusCode).toBe(401);
  });

  it('counts wrong step-up passwords like wrong logins: a run of them is throttled', async () => {
    const { ctx, owner } = await withOwner();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await invite(ctx, owner, { username: 'ana', password: 'not the password' })).res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // Even the right password waits out the window.
    expect((await invite(ctx, owner, { username: 'ana' })).res.statusCode).toBe(429);
  });
});

describe('reissue: a new invite, and an admin-driven password reset', () => {
  const holdEverything = async (ctx: AppContext, cookie: string) => {
    const pat = await mintFor(ctx, cookie);
    const stdio = await stdioSignedIn(ctx, cookie, { access: 'write', duration: '7d' });
    return { pat, stdio };
  };

  it('replaces the invite of someone who has not claimed one: the old code stops working', async () => {
    const { ctx, owner } = await withOwner();
    const first = await mustInvite(ctx, owner, { username: 'ana' });
    const id = await userIdOf(ctx, 'ana');

    const reissued = await post(ctx, owner, `${USERS_URL}/${id}/reissue`, { password: PASSWORD });
    const second = /data-testid="invite-code">([0-9A-Z-]+)</.exec(reissued.body)?.[1];

    expect(reissued.statusCode).toBe(200);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // One invite waits per user: the previous one is gone in the same batch.
    expect((await inviteRows(ctx)).filter((row) => row.used_at === null)).toHaveLength(1);
    expect((await claim(ctx, first)).statusCode).toBe(403);
    expect((await claim(ctx, second!)).statusCode).toBe(303);
  });

  it('resets a claimed user: password gone, every session, token and sign-in revoked, old invite dead', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const { pat, stdio } = await holdEverything(ctx, ana.cookie);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      200,
    );
    expect((await stdio.resolve()).kind).toBe('granted');

    const reissued = await post(ctx, owner, `${USERS_URL}/${ana.userId}/reissue`, { password: PASSWORD });

    expect(reissued.statusCode).toBe(200);
    expect(reissued.body).toContain('Their password is gone');
    const code = /data-testid="invite-code">([0-9A-Z-]+)</.exec(reissued.body)![1]!;

    // Everything the user held is ended, in the database …
    expect(await userRow(ctx, 'ana')).toMatchObject({ password_hash: null, disabled_at: null });
    expect(await countRows(ctx, 'sessions', ana.userId)).toBe(0);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect(await countRows(ctx, 'access_tokens', ana.userId)).toBe(2); // the rows stay, revoked
    // … and on every channel.
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).statusCode).toBe(303);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      401,
    );
    expect((await stdio.resolve()).kind).toBe('not_signed_in');
    expect((await loginAs(ctx, 'ana')).statusCode).toBe(401);
    // The invite already used is gone from the unclaimed set; only the new one claims.
    expect((await inviteRows(ctx)).filter((row) => row.used_at === null)).toHaveLength(1);
    const claimed = await claim(ctx, code, 'a brand new passphrase');
    expect(claimed.statusCode).toBe(303);
    expect((await loginAs(ctx, 'ana', 'a brand new passphrase')).statusCode).toBe(303);
  });

  it('changes nothing when the step-up password is wrong', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const { pat } = await holdEverything(ctx, ana.cookie);

    const refused = await post(ctx, owner, `${USERS_URL}/${ana.userId}/reissue`, { password: 'not the password' });

    expect(refused.statusCode).toBe(403);
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      200,
    );
    expect(await userRow(ctx, 'ana')).toMatchObject({ password_hash: expect.stringContaining('argon2id') });
  });

  it('refuses to reset a disabled user until they are enabled', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });

    const refused = await post(ctx, owner, `${USERS_URL}/${ana.userId}/reissue`, { password: PASSWORD });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('disabled');
  });

  it('refuses to reset the only admin, who would be left with no way in', async () => {
    const { ctx, owner } = await withOwner();
    const refused = await post(ctx, owner, `${USERS_URL}/${await userIdOf(ctx, 'rafael')}/reissue`, {
      password: PASSWORD,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('without an active administrator');
    expect((await get(ctx, owner, USERS_URL)).statusCode).toBe(200);
  });

  it('gives a reset owner an invite rather than a setup page: the instance is not "unclaimed"', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    await post(ctx, boss.cookie, `${USERS_URL}/${await userIdOf(ctx, 'rafael')}/reissue`, {
      password: MEMBER_PASSWORD,
    });

    const login = await ctx.app.inject({ method: 'GET', url: '/ui/login', headers: { host: LOOPBACK_HOST } });
    expect(login.statusCode).toBe(200);
    const setup = await ctx.app.inject({ method: 'GET', url: '/ui/setup', headers: { host: LOOPBACK_HOST } });
    expect(setup.statusCode).toBe(302);
    expect(setup.headers.location).toBe('/ui/login');
  });
});

describe('disable and enable', () => {
  it('ends every credential at once and blocks login, bearer and stdio', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const pat = await mintFor(ctx, ana.cookie);
    const stdio = await stdioSignedIn(ctx, ana.cookie);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      200,
    );

    const disabled = await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });

    expect(disabled.statusCode).toBe(303);
    expect(await userRow(ctx, 'ana')).toMatchObject({ disabled_at: expect.any(String) });
    expect(await countRows(ctx, 'sessions', ana.userId)).toBe(0);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect((await loginAs(ctx, 'ana')).statusCode).toBe(401);
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).statusCode).toBe(303);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      401,
    );
    expect((await stdio.resolve()).kind).toBe('not_signed_in');
  });

  it('keeps a disabled user from redeeming a sign-in they had already approved', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const { session } = stdioSessionFor(ctx);
    await approveConnect(ctx, ana.cookie, userCodeIn(await session.resolve()), {});

    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });

    expect((await session.resolve()).kind).toBe('not_signed_in');
    expect(await ctx.db.all(sql`SELECT * FROM access_tokens WHERE kind = 'stdio'`)).toEqual([]);
  });

  it('restores login only: the earlier session, token and sign-in stay dead', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const pat = await mintFor(ctx, ana.cookie);
    const stdio = await stdioSignedIn(ctx, ana.cookie);
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });

    const enabled = await post(ctx, owner, `${USERS_URL}/${ana.userId}/enable`, { password: PASSWORD });

    expect(enabled.statusCode).toBe(303);
    expect(await userRow(ctx, 'ana')).toMatchObject({ disabled_at: null });
    const login = await loginAs(ctx, 'ana');
    expect(login.statusCode).toBe(303);
    expect((await get(ctx, sessionCookieOf(login)!, '/ui/access/tokens')).statusCode).toBe(200);
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).statusCode).toBe(303);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      401,
    );
    expect((await stdio.resolve()).kind).toBe('not_signed_in');
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });

  it('leaves everyone else’s credentials alone', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const bob = await addUser(ctx, owner, 'bob');
    const bobsToken = await mintFor(ctx, bob.cookie);

    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });

    expect((await get(ctx, bob.cookie, '/ui/access/tokens')).statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(bobsToken.token) })).statusCode,
    ).toBe(200);
    expect((await get(ctx, owner, USERS_URL)).statusCode).toBe(200);
  });

  it('refuses an admin disabling or demoting themself', async () => {
    const { ctx, owner } = await withOwner();
    await addUser(ctx, owner, 'boss', 'admin');
    const self = await userIdOf(ctx, 'rafael');

    const disable = await post(ctx, owner, `${USERS_URL}/${self}/disable`, { password: PASSWORD });
    const demote = await post(ctx, owner, `${USERS_URL}/${self}/role`, { role: 'member', password: PASSWORD });

    expect(disable.statusCode).toBe(409);
    expect(disable.body).toContain('cannot disable or demote yourself');
    expect(demote.statusCode).toBe(409);
    expect(await userRow(ctx, 'rafael')).toMatchObject({ role: 'admin', disabled_at: null });
  });

  it('lets one admin disable or demote another while one remains', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');

    const demote = await post(ctx, owner, `${USERS_URL}/${boss.userId}/role`, { role: 'member', password: PASSWORD });
    expect(demote.statusCode).toBe(303);
    expect(await userRow(ctx, 'boss')).toMatchObject({ role: 'member' });
    // The demoted admin's very next request already finds the pages gone.
    expect((await get(ctx, boss.cookie, USERS_URL)).statusCode).toBe(404);
  });

  it('promotes a member to admin', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/role`, { role: 'admin', password: PASSWORD });
    expect((await get(ctx, ana.cookie, USERS_URL)).statusCode).toBe(200);
  });

  it('reports an unknown user as not found, in the page', async () => {
    const { ctx, owner } = await withOwner();
    const res = await post(ctx, owner, `${USERS_URL}/no-such-user/disable`, { password: PASSWORD });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('No such user');
  });
});

describe('a credential cannot be issued to a user after theirs were ended', () => {
  it('does not let a sign-in approved before a disable be redeemed after the user is enabled again', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const { session } = stdioSessionFor(ctx);
    await approveConnect(ctx, ana.cookie, userCodeIn(await session.resolve()), {});

    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/enable`, { password: PASSWORD });

    expect((await session.resolve()).kind).toBe('not_signed_in');
    expect(await ctx.db.all(sql`SELECT * FROM access_tokens WHERE kind = 'stdio'`)).toEqual([]);
  });

  it('does not let a token mint that read the user before a disable commit after it', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const input = { name: 'raced', access: 'write' as const, expiry: '30' as const, password: MEMBER_PASSWORD };

    const stale = (await createToken(deps, ana.userId, input))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });
    let first = true;
    const minted = await run(() => {
      if (!first) return createToken(deps, ana.userId, input);
      first = false;
      return okAsync(stale);
    });

    // The stale batch conflicts on the user's version; its retry sees a disabled user and refuses.
    expect(minted.isErr()).toBe(true);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });
});

describe('a request authorized before a change to its author cannot outlive that change', () => {
  it('refuses a sign-in approval that commits after the approver was disabled', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const { session } = stdioSessionFor(ctx);
    const userCode = userCodeIn(await session.resolve());
    const principal: Principal = {
      userId: ana.userId,
      role: UserRole.enum.member,
      scopes: [...ALL_SCOPES],
      via: PrincipalVia.enum.session,
    };
    const input = { userCode, access: 'read' as const, duration: '24h' as const };

    const stale = (await approveGrant(deps, principal, input))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });
    let first = true;
    const approved = await run(() => {
      if (!first) return approveGrant(deps, principal, input);
      first = false;
      return okAsync(stale);
    });

    expect(approved.isErr()).toBe(true);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'pending' }]);
  });

  it('refuses an invitation sent by an admin who was demoted after it was authorized', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const actor: Actor = {
      kind: ActorKind.enum.session,
      principal: {
        userId: boss.userId,
        role: UserRole.enum.admin,
        scopes: [...ALL_SCOPES],
        via: PrincipalVia.enum.session,
      },
      password: MEMBER_PASSWORD,
    };
    const input = { username: 'late-guest', role: UserRole.enum.member };

    const stale = (await inviteUser(deps, actor, input))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/${boss.userId}/role`, { role: 'member', password: PASSWORD });
    let first = true;
    const invited = await run(() => {
      if (!first) return inviteUser(deps, actor, input);
      first = false;
      return okAsync(stale);
    });

    expect(invited.isErr()).toBe(true);
    expect(await userRow(ctx, 'late-guest')).toBeUndefined();
  });
});

describe('a redemption cannot outlive a cap lowered while it was in flight', () => {
  const redeemRacingCap = async (settingBefore?: '30d') => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    if (settingBefore) {
      await post(ctx, owner, `${USERS_URL}/sign-in-cap`, { maxSignInDuration: '7d', password: PASSWORD });
      await post(ctx, owner, `${USERS_URL}/sign-in-cap`, { maxSignInDuration: settingBefore, password: PASSWORD });
    }
    const principal: Principal = {
      userId: ana.userId,
      role: UserRole.enum.member,
      scopes: [...ALL_SCOPES],
      via: PrincipalVia.enum.session,
    };
    const started = (
      await run(() => startGrant(deps, { client: { name: 't', version: '1' }, profile: 'p', channel: 'stdio' }))
    )._unsafeUnwrap();
    const input = { userCode: started.userCode, access: 'read' as const, duration: '30d' as const };
    (await run(() => approveGrant(deps, principal, input)))._unsafeUnwrap();

    // The redemption reads the cap (30 days), then an admin — a different user — lowers it before it commits.
    const stale = (await redeemGrant(deps, started.deviceCode))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/sign-in-cap`, { maxSignInDuration: '24h', password: PASSWORD });
    let first = true;
    const redeemed = await run(() => {
      if (!first) return redeemGrant(deps, started.deviceCode);
      first = false;
      return okAsync(stale);
    });
    return { ctx, redeemed };
  };

  it.each([
    ['no admin had saved a setting yet (the settings row is absent)', undefined],
    ['the cap was already saved at 30 days', '30d' as const],
  ])('retries and applies the new cap when %s', async (_label, settingBefore) => {
    const { ctx, redeemed } = await redeemRacingCap(settingBefore);

    expect(redeemed.isOk()).toBe(true);
    const [token] = await ctx.db.all<{ expires_at: string; created_at: string }>(
      sql`SELECT expires_at, created_at FROM access_tokens WHERE kind = 'stdio'`,
    );
    expect(Date.parse(token!.expires_at) - Date.parse(token!.created_at)).toBeLessThanOrEqual(24 * HOUR_MS);
  });
});

describe('the last active admin survives concurrent changes (version conflict)', () => {
  const principalOf = (userId: string): Principal => ({
    userId,
    role: UserRole.enum.admin,
    scopes: [...ALL_SCOPES],
    via: PrincipalVia.enum.session,
  });
  const adminRows = (ctx: AppContext) =>
    ctx.db.all<{ username: string }>(
      sql`SELECT username FROM users WHERE role = 'admin' AND disabled_at IS NULL AND password_hash IS NOT NULL`,
    );

  it('refuses the second of two admins disabling each other from the same stale read', async () => {
    const { ctx, owner } = await withOwner();
    await addUser(ctx, owner, 'boss', 'admin');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const rootId = await userIdOf(ctx, 'rafael');
    const bossId = await userIdOf(ctx, 'boss');
    const actor = (userId: string) => ({
      kind: 'session' as const,
      principal: principalOf(userId),
      password: PASSWORD,
    });

    // Both flows read "the other one is still an admin" BEFORE either commits …
    const staleRootDisablesBoss = (await disableUser(deps, actor(rootId), bossId))._unsafeUnwrap();
    const staleBossDisablesRoot = (await disableUser(deps, actor(bossId), rootId))._unsafeUnwrap();

    // … then they commit one after the other. The engine re-runs a flow whose reads went stale; the second re-run
    // sees the first's effect and is refused. Without the admins re-written as witnesses, both stale batches would
    // commit and nobody would be left to administer.
    const fresh = (adminId: string, targetId: string) => () => disableUser(deps, actor(adminId), targetId);
    let first = true;
    const firstRun = await run(() => {
      if (!first) return fresh(rootId, bossId)();
      first = false;
      return okAsync(staleRootDisablesBoss);
    });
    let second = true;
    const secondRun = await run(() => {
      if (!second) return fresh(bossId, rootId)();
      second = false;
      return okAsync(staleBossDisablesRoot);
    });

    expect(firstRun.isOk()).toBe(true);
    expect(secondRun.isErr()).toBe(true);
    expect(await adminRows(ctx)).toEqual([{ username: 'rafael' }]);
  });

  it('holds over HTTP too: two admins disabling each other at once leave exactly one', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const rootId = await userIdOf(ctx, 'rafael');

    const [a, b] = await Promise.all([
      post(ctx, owner, `${USERS_URL}/${boss.userId}/disable`, { password: PASSWORD }),
      post(ctx, boss.cookie, `${USERS_URL}/${rootId}/disable`, { password: MEMBER_PASSWORD }),
    ]);

    expect([a.statusCode, b.statusCode].filter((status) => status === 303)).toHaveLength(1);
    expect(await adminRows(ctx)).toHaveLength(1);
  });

  it('holds for demotions too', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const rootId = await userIdOf(ctx, 'rafael');

    await Promise.all([
      post(ctx, owner, `${USERS_URL}/${boss.userId}/role`, { role: 'member', password: PASSWORD }),
      post(ctx, boss.cookie, `${USERS_URL}/${rootId}/role`, { role: 'member', password: MEMBER_PASSWORD }),
    ]);

    expect(await adminRows(ctx)).toHaveLength(1);
  });
});

describe('who can reach user management', () => {
  const forgedPosts = (ownerId: string): Array<[string, Record<string, string>]> => [
    [USERS_URL, { username: 'mallory', role: 'admin', password: PASSWORD }],
    [`${USERS_URL}/sign-in-cap`, { maxSignInDuration: '24h', password: PASSWORD }],
    [`${USERS_URL}/${ownerId}/reissue`, { password: PASSWORD }],
    [`${USERS_URL}/${ownerId}/disable`, { password: PASSWORD }],
    [`${USERS_URL}/${ownerId}/enable`, { password: PASSWORD }],
    [`${USERS_URL}/${ownerId}/role`, { role: 'member', password: PASSWORD }],
  ];

  const notFoundBody = (body: string, path: string): string => body.replaceAll(path, '<path>');

  it('answers a member on every route — the page and each form post — as a page that does not exist', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const ownerId = await userIdOf(ctx, 'rafael');
    const before = { users: await userRows(ctx), invites: await inviteRows(ctx) };

    const unknown = await get(ctx, ana.cookie, '/ui/access/nothing-here');
    expect(unknown.statusCode).toBe(404);

    const page = await get(ctx, ana.cookie, USERS_URL);
    expect(page.statusCode).toBe(404);
    expect(notFoundBody(page.body, USERS_URL)).toBe(notFoundBody(unknown.body, '/ui/access/nothing-here'));

    for (const [url, fields] of forgedPosts(ownerId)) {
      const res = await post(ctx, ana.cookie, url, fields);
      expect(res.statusCode, url).toBe(404);
      expect(notFoundBody(res.body, url), url).not.toContain('administrator');
      expect(res.body, url).not.toContain('Users');
    }

    // The forged posts did nothing: nobody invited, nobody promoted or disabled, no cap saved.
    expect(await userRows(ctx)).toEqual(before.users);
    expect(await inviteRows(ctx)).toEqual(before.invites);
    expect(await ctx.db.all(sql`SELECT * FROM settings`)).toEqual([]);
  });

  it('does not even link to the page for a member, and does for an admin', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).body).not.toContain(USERS_URL);
    expect((await get(ctx, owner, '/ui/access/tokens')).body).toContain(USERS_URL);
  });

  it('answers a visitor with no session as it answers for every other /ui page: the login redirect', async () => {
    const { ctx } = await withOwner();
    const page = await ctx.app.inject({ method: 'GET', url: USERS_URL, headers: { host: LOOPBACK_HOST } });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toContain('/ui/login');
  });

  it.each(['read', 'write'] as const)(
    'is not reachable with a %s-scoped bearer token, on /ui or /api',
    async (access) => {
      const { ctx, owner } = await withOwner();
      const holder = await mintToken(ctx, owner, { access });
      const before = await userRows(ctx);

      // /ui ignores a bearer: it is no credential there, so the answer is the login redirect.
      const ui = await ctx.app.inject({
        method: 'GET',
        url: USERS_URL,
        headers: { host: LOOPBACK_HOST, ...bearer(holder.token) },
      });
      expect(ui.statusCode).toBe(303);
      const formPost = await ctx.app.inject({
        method: 'POST',
        url: USERS_URL,
        headers: { ...browserHeaders('x=y'), cookie: '', ...bearer(holder.token) },
        payload: formBody({ username: 'mallory', role: 'admin', password: PASSWORD }),
      });
      expect(formPost.statusCode).toBe(303);

      // There is no /api route for any of it: not found for a token that may write, refused for one that may not.
      for (const [method, url] of [
        ['GET', '/api/users'],
        ['POST', '/api/users'],
        ['POST', '/api/access/users'],
        ['POST', '/api/invites'],
        ['POST', '/api/users/x/disable'],
        ['GET', '/api/settings/sign-in-cap'],
      ] as const) {
        const res = await ctx.app.inject({
          method,
          url,
          headers: bearer(holder.token),
          payload: method === 'POST' ? {} : undefined,
        });
        expect(res.statusCode, `${method} ${url}`).toBe(access === 'read' && method === 'POST' ? 403 : 404);
      }
      expect(await userRows(ctx)).toEqual(before);
    },
  );

  it('registers no user-management route outside /ui, and no MCP tool for it', async () => {
    const { ctx } = await withOwner();
    const { registeredRoutes } = await import('./helpers.js');
    const routes = await registeredRoutes(ctx);
    const management = routes.filter(({ url }) => /\/(users|invite|invites)\b|sign-in-cap/.test(url));
    expect(management.length).toBeGreaterThan(5);
    expect(management.filter(({ url }) => !url.startsWith('/ui/'))).toEqual([]);

    const { buildMcpServer } = await import('../../../src/diplomat/mcp/server.js');
    const { ownerGate } = await import('../../../src/diplomat/mcp/gate.js');
    const { toolScopesOf } = await import('../../../src/diplomat/mcp/scopes.js');
    const tools = [...toolScopesOf(buildMcpServer({} as never, '0', { gate: ownerGate })).keys()];
    expect(tools.filter((name) => /user|invite|admin|role|cap\b/.test(name))).toEqual([]);
  });

  it('checks the Origin of every post: a forged cross-site post is refused and does nothing', async () => {
    const { ctx, owner } = await withOwner();
    const ownerId = await userIdOf(ctx, 'rafael');
    const code = await mustInvite(ctx, owner, { username: 'ana' });
    const before = { users: await userRows(ctx), invites: await inviteRows(ctx) };

    const evil = { ...browserHeaders(owner), origin: 'http://evil.example' };
    for (const [url, fields] of forgedPosts(ownerId)) {
      const res = await ctx.app.inject({ method: 'POST', url, headers: evil, payload: formBody(fields) });
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).toContain('forbidden_origin');
    }
    // The claim page is public, but a browser that declares a foreign Origin may not post to it either.
    const claimed = await claim(ctx, code, MEMBER_PASSWORD, { origin: 'http://evil.example' });
    expect(claimed.statusCode).toBe(403);

    expect(await userRows(ctx)).toEqual(before.users);
    expect(await inviteRows(ctx)).toEqual(before.invites);
  });

  it('covers every user-management POST in these forgeries (a new route would fail here)', async () => {
    const { ctx } = await withOwner();
    const { registeredRoutes } = await import('./helpers.js');
    const posts = (await registeredRoutes(ctx))
      .filter(({ method, url }) => method === 'POST' && url.startsWith(USERS_URL))
      .map(({ url }) => url.replace(':id', 'ID'))
      .sort();
    const forged = forgedPosts('ID')
      .map(([url]) => url)
      .sort();
    expect(posts).toEqual(forged);
  });
});

describe('the claim page', () => {
  it('never lets the code travel in a Referer, and is locked down like the other sign-in pages', async () => {
    const { ctx, owner } = await withOwner();
    const code = await mustInvite(ctx, owner, { username: 'ana' });

    const shown = await ctx.app.inject({
      method: 'GET',
      url: `/ui/invite?code=${code}`,
      headers: { host: LOOPBACK_HOST },
    });
    const refused = await claim(ctx, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
    const invalid = await claim(ctx, code, 'short');

    for (const res of [shown, refused, invalid]) {
      expect(res.headers['referrer-policy']).toBe('strict-origin');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
    // Never `no-referrer`, in the header or a <meta>: a browser then sends `Origin: null` with the form, which the CSRF
    // check refuses — a claim would never work (found by claiming in a real browser).
    expect(shown.body).not.toContain('name="referrer"');
  });

  it('refuses a claim whose Origin is the opaque "null" (what `no-referrer` would send)', async () => {
    const { ctx, owner } = await withOwner();
    const code = await mustInvite(ctx, owner, { username: 'ana' });

    expect((await claim(ctx, code, MEMBER_PASSWORD, { origin: 'null' })).statusCode).toBe(403);
    expect((await userRow(ctx, 'ana'))?.password_hash).toBeNull();
    expect((await claim(ctx, code)).statusCode).toBe(303);
  });

  it('escapes whatever the link carries', async () => {
    const { ctx } = await withOwner();
    const shown = await ctx.app.inject({
      method: 'GET',
      url: `/ui/invite?code=${encodeURIComponent('"><script>alert(1)</script>')}`,
      headers: { host: LOOPBACK_HOST },
    });
    expect(shown.body).not.toContain('<script>');
    expect(shown.body).toContain('&lt;script&gt;');
  });

  it('is public, like /ui/setup, and shows no other page without a session', async () => {
    const { ctx } = await withOwner();
    const shown = await ctx.app.inject({ method: 'GET', url: '/ui/invite', headers: { host: LOOPBACK_HOST } });
    expect(shown.statusCode).toBe(200);
  });

  it('puts the secret in the rendered result page only once, and never in a later page or the list', async () => {
    const { ctx, owner } = await withOwner();
    const { res, code } = await invite(ctx, owner, { username: 'ana' });
    expect(res.headers['cache-control']).toBe('no-store');
    const list = (await get(ctx, owner, USERS_URL)).body;
    expect(list).not.toContain(code);
    expect(list).not.toContain(code.replaceAll('-', ''));
  });
});

describe('the sign-in cap (ADR-034 §4)', () => {
  const setCap = (ctx: AppContext, cookie: string, maxSignInDuration: string) =>
    post(ctx, cookie, `${USERS_URL}/sign-in-cap`, { maxSignInDuration, password: PASSWORD });
  const radios = (html: string) => [...html.matchAll(/name="duration" value="([^"]+)"/g)].map((m) => m[1]);
  const tokenExpiries = (ctx: AppContext) =>
    ctx.db.all<{ expires_at: string; created_at: string }>(
      sql`SELECT expires_at, created_at FROM access_tokens WHERE kind = 'stdio' ORDER BY created_at`,
    );
  const pendingConsentPage = async (ctx: AppContext, cookie: string) => {
    const { session } = stdioSessionFor(ctx);
    const code = userCodeIn(await session.resolve());
    return { session, code, html: (await get(ctx, cookie, `/ui/connect?code=${code}`)).body };
  };

  it('is 30 days until an admin lowers it, and the consent page offers everything up to it', async () => {
    const { ctx, owner } = await withOwner();
    expect(radios((await pendingConsentPage(ctx, owner)).html)).toEqual(['session', '24h', '7d', '30d']);
  });

  it('never offers a duration above the cap', async () => {
    const { ctx, owner } = await withOwner();
    expect((await setCap(ctx, owner, '7d')).statusCode).toBe(303);
    expect(radios((await pendingConsentPage(ctx, owner)).html)).toEqual(['session', '24h', '7d']);
    expect((await setCap(ctx, owner, '24h')).statusCode).toBe(303);
    expect(radios((await pendingConsentPage(ctx, owner)).html)).toEqual(['session', '24h']);
    expect(await ctx.db.all(sql`SELECT id, max_sign_in_duration FROM settings`)).toEqual([
      { id: 'singleton', max_sign_in_duration: '24h' },
    ]);
  });

  it('clamps an approval that asks for more, even from a hand-made form', async () => {
    const { ctx, owner } = await withOwner();
    await setCap(ctx, owner, '7d');
    const { session, code } = await pendingConsentPage(ctx, owner);

    await approveConnect(ctx, owner, code, { duration: '30d' });
    expect((await session.resolve()).kind).toBe('granted');

    const [token] = await tokenExpiries(ctx);
    const lasts = Date.parse(token!.expires_at) - Date.parse(token!.created_at);
    expect(lasts).toBeLessThanOrEqual(7 * 24 * HOUR_MS);
    expect(lasts).toBeGreaterThan(6 * 24 * HOUR_MS);
    expect(await ctx.db.all(sql`SELECT duration FROM client_grants`)).toEqual([{ duration: '7d' }]);
  });

  it('leaves sign-ins that already last longer exactly as long as they were granted', async () => {
    const { ctx, owner } = await withOwner();
    const session = await stdioSignedIn(ctx, owner, { duration: '30d' });
    const [before] = await tokenExpiries(ctx);

    expect((await setCap(ctx, owner, '24h')).statusCode).toBe(303);

    expect(await tokenExpiries(ctx)).toEqual([before]);
    expect((await session.resolve()).kind).toBe('granted');
    expect(Date.parse(before!.expires_at) - Date.parse(before!.created_at)).toBeGreaterThan(29 * 24 * HOUR_MS);
  });

  it('clamps a sign-in approved before the cap fell when it is redeemed after', async () => {
    const { ctx, owner } = await withOwner();
    const { session, code } = await pendingConsentPage(ctx, owner);
    await approveConnect(ctx, owner, code, { duration: '30d' });
    await setCap(ctx, owner, '24h');

    expect((await session.resolve()).kind).toBe('granted');
    const [token] = await tokenExpiries(ctx);
    expect(Date.parse(token!.expires_at) - Date.parse(token!.created_at)).toBeLessThanOrEqual(24 * HOUR_MS);
  });
});

describe('a member’s stdio sign-in is the member’s', () => {
  it('acts as the member, with the scopes the member chose', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const session = await stdioSignedIn(ctx, ana.cookie, { access: 'read' });

    const outcome = await session.resolve();
    expect(outcome.kind === 'granted' && outcome.principal).toMatchObject({
      userId: ana.userId,
      role: 'member',
      scopes: ['fintrack:read'],
      via: 'stdio',
    });
    expect(await ctx.db.all(sql`SELECT user_id FROM access_tokens WHERE kind = 'stdio'`)).toEqual([
      { user_id: ana.userId },
    ]);
  });
});
