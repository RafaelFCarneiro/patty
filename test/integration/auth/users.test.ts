import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { createToken } from '../../../src/controllers/auth/access-tokens.js';
import { resetPassword } from '../../../src/controllers/auth/password.js';
import { approveGrant, redeemGrant, startGrant } from '../../../src/controllers/auth/grants.js';
import { disableUser, enableUser, inviteUser, reissueInvite } from '../../../src/controllers/auth/users.js';
import { authErrors } from '../../../src/models/auth/errors.js';
import { USER_ENTITY_TAG } from '../../../src/models/auth/entity.js';
import { GrantStatus, SignInDuration } from '../../../src/models/auth/grant.js';
import { UserRole } from '../../../src/models/auth/owner.js';
import { TokenAccess } from '../../../src/models/auth/token.js';
import { ActorKind, DEFAULT_SIGN_IN_CAP, INSTANCE_SETTINGS_ID, type Actor } from '../../../src/models/auth/users.js';
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
  codeFrom,
  FORM_HEADERS,
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
  sessionPrincipalFor,
  mustClaim,
  mustInvite,
  post,
  userIdOf,
  userRow,
  userRows,
  USERS_URL,
  countRows,
} from './user-helpers.js';
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

/** What a person approves in the consent page: read-only access for a day. */
const approvalFor = (userCode: string) => ({
  userCode,
  access: TokenAccess.enum.read,
  duration: SignInDuration.enum['24h'],
  password: MEMBER_PASSWORD,
});

/** The instance settings row a migration guarantees: the default cap, never written until an admin changes it. */
const DEFAULT_SETTINGS_ROW = {
  id: INSTANCE_SETTINGS_ID,
  max_sign_in_duration: DEFAULT_SIGN_IN_CAP,
  instance_kind: 'standard',
  demo_seeded_at: null,
  demo_country: null,
  version: 0,
};

describe('invite → claim → login', () => {
  it('lets an admin invite a person who then chooses their own password and lands signed in', async () => {
    const { ctx, owner } = await withOwner();

    const { res, code, link } = await invite(ctx, owner, { username: 'Ana' });
    expect(res.statusCode).toBe(200);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    expect(link).toBe(`${LOOPBACK_ORIGIN}/ui/access/invite?code=${code}`);

    // The unclaimed row exists with a username and role but no password; the invite stores only a hash.
    expect(await userRow(ctx, 'ana')).toMatchObject({ role: 'member', password_hash: null, disabled_at: null });
    const [stored] = await inviteRows(ctx);
    expect(stored).toMatchObject({ used_at: null });
    expect(stored?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await inviteRows(ctx))).not.toContain(code.replaceAll('-', ''));
    expect(JSON.stringify(await ctx.db.all(sql`SELECT * FROM users`))).not.toContain(code);

    const page = await ctx.app.inject({
      method: 'GET',
      url: `/ui/access/invite?code=${code}`,
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

describe('the owner cannot be claimed into a name another user holds', () => {
  it('refuses setup as a username invited before the owner was set up — a page, not a database error', async () => {
    const ctx = await createApp();
    const run = bindAuthRunEffects(ctx.authRunEffects);
    (
      await run(() =>
        inviteUser(authDepsOf(ctx), { kind: ActorKind.enum.terminal }, { username: 'ana', role: 'member' }),
      )
    )._unsafeUnwrap();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/ui/setup',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
      payload: formBody({ code: codeFrom(ctx.announced), username: 'Ana', password: PASSWORD }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('already taken');
    expect((await userRow(ctx, 'ana'))?.password_hash).toBeNull();
    expect((await userRows(ctx)).filter((row) => row.username === null)).toHaveLength(1); // the owner, still unclaimed
  });
});

describe('a user invited before the owner was set up can still sign in', () => {
  it('reaches the login form, not setup, from /ui/login and any /ui page; setup stays open for the owner', async () => {
    const ctx = await createApp();
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const issued = (
      await run(() =>
        inviteUser(authDepsOf(ctx), { kind: ActorKind.enum.terminal }, { username: 'ana', role: 'member' }),
      )
    )._unsafeUnwrap();
    const before = await ctx.app.inject({ method: 'GET', url: '/ui', headers: { host: LOOPBACK_HOST } });
    expect(before.headers.location).toBe('/ui/setup'); // nobody can log in yet: still setup first

    expect((await claim(ctx, issued.code)).statusCode).toBe(303);

    // Logged out (no cookie): ana is sent to log in, and the login page is a form.
    const page = await ctx.app.inject({ method: 'GET', url: '/ui', headers: { host: LOOPBACK_HOST } });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toContain('/ui/login');
    const login = await ctx.app.inject({ method: 'GET', url: '/ui/login', headers: { host: LOOPBACK_HOST } });
    expect(login.statusCode).toBe(200);
    expect((await loginAs(ctx, 'ana')).statusCode).toBe(303);
    // The owner can still be claimed at the setup address.
    const setup = await ctx.app.inject({ method: 'GET', url: '/ui/setup', headers: { host: LOOPBACK_HOST } });
    expect(setup.statusCode).toBe(200);
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
    expect(await ctx.db.all(sql`SELECT * FROM settings`)).toEqual([DEFAULT_SETTINGS_ROW]);
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

    const anaSession = await sessionPrincipalFor(ctx, ana.userId);
    const stale = (await createToken(deps, anaSession, input))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });
    let first = true;
    const minted = await run(() => {
      if (!first) return createToken(deps, anaSession, input);
      first = false;
      return okAsync(stale);
    });

    // The stale batch conflicts on the user's version; its retry sees a disabled user and refuses.
    expect(minted.isErr()).toBe(true);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });
});

describe('a token request cannot outlive the session it came through', () => {
  it('refuses a token retried after a disable and re-enable ended its session, and mints nothing', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const anaSession = await sessionPrincipalFor(ctx, ana.userId);
    const input = { name: 'raced', access: 'write' as const, expiry: '30' as const, password: MEMBER_PASSWORD };

    const stale = (await createToken(deps, anaSession, input))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/disable`, { password: PASSWORD });
    await post(ctx, owner, `${USERS_URL}/${ana.userId}/enable`, { password: PASSWORD });
    // Active again, same password — but the session the request came through is gone.
    expect(await ctx.db.all(sql`SELECT id FROM sessions WHERE user_id = ${ana.userId}`)).toEqual([]);
    let first = true;
    const minted = await run(() => {
      if (!first) return createToken(deps, anaSession, input);
      first = false;
      return okAsync(stale);
    });

    expect(minted._unsafeUnwrapErr()).toEqual(authErrors.unauthenticated);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });
});

describe('a row that is only checked is not written or announced', () => {
  const versionOf = async (ctx: AppContext, id: string) =>
    (await ctx.db.all<{ version: number }>(sql`SELECT version FROM users WHERE id = ${id}`))[0]?.version;
  const announced = (ctx: AppContext) => {
    const events: Array<{ entities: readonly string[] }> = [];
    ctx.changeBus.subscribe((event) => events.push(event));
    return events;
  };

  it('leaves the acting admin’s row at its version when they invite someone', async () => {
    const { ctx, owner } = await withOwner();
    const adminId = await userIdOf(ctx, 'rafael');
    const before = await versionOf(ctx, adminId);
    const events = announced(ctx);

    await addUser(ctx, owner, 'ana');

    expect(await versionOf(ctx, adminId)).toBe(before);
    expect(events.flatMap((event) => event.entities)).toContain(USER_ENTITY_TAG);
  });

  it('leaves the admins left standing and the settings row at their versions, writing only what changed', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const settingsVersion = () =>
      ctx.db.all<{ version: number }>(sql`SELECT version FROM settings`).then((rows) => rows[0]?.version);
    const [rootBefore, settingsBefore] = [await versionOf(ctx, await userIdOf(ctx, 'rafael')), await settingsVersion()];

    // Disabling the other admin checks the owner (acting and left standing) and the sign-in redemption checks settings.
    await post(ctx, owner, `${USERS_URL}/${boss.userId}/disable`, { password: PASSWORD });
    const { session } = stdioSessionFor(ctx);
    await approveConnect(ctx, ana.cookie, userCodeIn(await session.resolve()), {});
    await session.resolve();

    expect(await versionOf(ctx, await userIdOf(ctx, 'rafael'))).toBe(rootBefore);
    expect(await settingsVersion()).toBe(settingsBefore);
  });

  it('stamps credentials_changed_at and moves the version of a user who is issued a credential', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const stamp = async () =>
      (
        await ctx.db.all<{ at: string | null; version: number }>(
          sql`SELECT credentials_changed_at AS at, version FROM users WHERE id = ${ana.userId}`,
        )
      )[0];
    const before = await stamp();
    const events = announced(ctx);

    await mintFor(ctx, ana.cookie);

    const after = await stamp();
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(Date.parse(after?.at ?? '')).toBeGreaterThanOrEqual(Date.parse(before?.at ?? ''));
    expect(events.flatMap((event) => event.entities)).toContain(USER_ENTITY_TAG);
  });
});

describe('a revocation cannot miss a credential issued while it was reading', () => {
  const adminActorOf = async (ctx: AppContext, userId: string) => ({
    kind: 'session' as const,
    principal: await sessionPrincipalFor(ctx, userId, UserRole.enum.admin),
    password: PASSWORD,
  });
  const tokenInput = { name: 'late', access: 'write' as const, expiry: '30' as const, password: MEMBER_PASSWORD };
  const status = (ctx: AppContext, token: string) =>
    ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(token) }).then((res) => res.statusCode);

  /**
   * Wraps one read so that on its FIRST call `issue` runs to completion after the read returned its snapshot: the
   * revocation then holds a list that is already stale. The flow re-runs on a conflict, so the hook fires once.
   */
  const issuingDuringFirstRead = <A extends unknown[], R>(
    read: (...args: A) => Promise<R>,
    issue: () => Promise<void>,
  ) => {
    let calls = 0;
    return {
      read: async (...args: A): Promise<R> => {
        calls += 1;
        const snapshot = await read(...args);
        if (calls === 1) await issue();
        return snapshot;
      },
      calls: () => calls,
    };
  };

  const world = async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const deps = authDepsOf(ctx);
    const adminId = await userIdOf(ctx, 'rafael');
    return {
      ctx,
      owner,
      ana,
      deps,
      adminId,
      admin: await adminActorOf(ctx, adminId),
      anaSession: await sessionPrincipalFor(ctx, ana.userId),
      run: bindAuthRunEffects(ctx.authRunEffects),
    };
  };
  const withTokenList = (deps: ReturnType<typeof authDepsOf>, listByUser: typeof deps.accessTokens.listByUser) => ({
    ...deps,
    accessTokens: { ...deps.accessTokens, listByUser },
  });
  const withApprovedGrants = (
    deps: ReturnType<typeof authDepsOf>,
    listApprovedByUser: typeof deps.clientGrants.listApprovedByUser,
  ) => ({ ...deps, clientGrants: { ...deps.clientGrants, listApprovedByUser } });

  const startedGrant = async (deps: ReturnType<typeof authDepsOf>, run: ReturnType<typeof bindAuthRunEffects>) =>
    (
      await run(() => startGrant(deps, { client: { name: 't', version: '1' }, profile: 'p', channel: 'stdio' }))
    )._unsafeUnwrap();

  it('a. a personal token minted during a disable is revoked, and stays dead after enabling', async () => {
    const { ctx, ana, deps, admin, run, anaSession } = await world();
    let minted = '';
    const hook = issuingDuringFirstRead(deps.accessTokens.listByUser, async () => {
      minted = (await run(() => createToken(deps, anaSession, tokenInput)))._unsafeUnwrap().token;
    });

    const disabled = await run(() => disableUser(withTokenList(deps, hook.read), admin, ana.userId));

    expect(disabled.isOk()).toBe(true);
    expect(hook.calls()).toBe(2);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect(await status(ctx, minted)).toBe(401);
    expect((await run(() => enableUser(deps, admin, ana.userId))).isOk()).toBe(true);
    expect(await status(ctx, minted)).toBe(401);
  });

  it('b. a personal token minted during the reissue of a claimed user is revoked', async () => {
    const { ctx, ana, deps, admin, run, anaSession } = await world();
    let minted = '';
    const hook = issuingDuringFirstRead(deps.accessTokens.listByUser, async () => {
      minted = (await run(() => createToken(deps, anaSession, tokenInput)))._unsafeUnwrap().token;
    });

    const reissued = await run(() => reissueInvite(withTokenList(deps, hook.read), admin, ana.userId));

    expect(reissued.isOk()).toBe(true);
    expect(hook.calls()).toBe(2);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect(await status(ctx, minted)).toBe(401);
  });

  it('c. a personal token minted during a password reset is revoked', async () => {
    const { ctx, ana, deps, run, anaSession } = await world();
    let minted = '';
    const hook = issuingDuringFirstRead(deps.accessTokens.listByUser, async () => {
      minted = (await run(() => createToken(deps, anaSession, tokenInput)))._unsafeUnwrap().token;
    });

    const reset = await run(() =>
      resetPassword(withTokenList(deps, hook.read), { username: 'ana', password: 'a brand new passphrase' }),
    );

    expect(reset.isOk()).toBe(true);
    expect(hook.calls()).toBe(2);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect(await status(ctx, minted)).toBe(401);
  });

  it('d. a stdio sign-in redeemed during a disable, between its token and grant reads, is revoked', async () => {
    const { ctx, ana, deps, admin, run } = await world();
    const started = await startedGrant(deps, run);
    const approval = approvalFor(started.userCode);
    const anaSession = await sessionPrincipalFor(ctx, ana.userId);
    (await run(() => approveGrant(deps, anaSession, approval)))._unsafeUnwrap();
    const hook = issuingDuringFirstRead(deps.clientGrants.listApprovedByUser, async () => {
      expect((await run(() => redeemGrant(deps, started.deviceCode)))._unsafeUnwrap()).toMatchObject({
        kind: 'signed_in',
      });
    });

    const disabled = await run(() => disableUser(withApprovedGrants(deps, hook.read), admin, ana.userId));

    expect(disabled.isOk()).toBe(true);
    expect(hook.calls()).toBe(2);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect((await run(() => enableUser(deps, admin, ana.userId))).isOk()).toBe(true);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });

  it('e. a sign-in request approved during a disable is expired, so enabling later mints nothing', async () => {
    const { ctx, ana, deps, admin, run } = await world();
    const started = await startedGrant(deps, run);
    const approval = approvalFor(started.userCode);
    const anaSession = await sessionPrincipalFor(ctx, ana.userId);
    const hook = issuingDuringFirstRead(deps.clientGrants.listApprovedByUser, async () => {
      (await run(() => approveGrant(deps, anaSession, approval)))._unsafeUnwrap();
    });

    const disabled = await run(() => disableUser(withApprovedGrants(deps, hook.read), admin, ana.userId));

    expect(disabled.isOk()).toBe(true);
    expect(hook.calls()).toBe(2);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: GrantStatus.enum.expired }]);
    expect((await run(() => enableUser(deps, admin, ana.userId))).isOk()).toBe(true);
    const redeemed = (await run(() => redeemGrant(deps, started.deviceCode)))._unsafeUnwrap();
    expect(redeemed.kind).not.toBe('signed_in');
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });

  it('f. an invite issued to an unclaimed user during a disable (after pruning) is removed', async () => {
    const { ctx, owner, deps, admin, run } = await world();
    await mustInvite(ctx, owner, { username: 'bob' });
    const bobId = await userIdOf(ctx, 'bob');
    await ctx.db.run(sql`DELETE FROM invites`);
    let code = '';
    const hook = issuingDuringFirstRead(deps.invites.listUnclaimedByUser, async () => {
      code = (await run(() => reissueInvite(deps, admin, bobId)))._unsafeUnwrap().code;
    });

    const disabled = await run(() =>
      disableUser({ ...deps, invites: { ...deps.invites, listUnclaimedByUser: hook.read } }, admin, bobId),
    );

    expect(disabled.isOk()).toBe(true);
    expect(hook.calls()).toBe(2);
    expect(await inviteRows(ctx)).toEqual([]);
    expect((await run(() => enableUser(deps, admin, bobId))).isOk()).toBe(true);
    expect((await claim(ctx, code)).statusCode).toBe(403);
  });

  it('g. redeeming a sign-in stamps credentials_changed_at and bumps the approver row version', async () => {
    const { ctx, ana, deps, run, anaSession } = await world();
    const started = await startedGrant(deps, run);
    (await run(() => approveGrant(deps, anaSession, approvalFor(started.userCode))))._unsafeUnwrap();
    const stamp = async () =>
      (
        await ctx.db.all<{ at: string | null; version: number }>(
          sql`SELECT credentials_changed_at AS at, version FROM users WHERE id = ${ana.userId}`,
        )
      )[0];
    const approved = await stamp();

    expect((await run(() => redeemGrant(deps, started.deviceCode)))._unsafeUnwrap()).toMatchObject({
      kind: 'signed_in',
    });

    const redeemed = await stamp();
    expect(redeemed?.version).toBe((approved?.version ?? 0) + 1);
    expect(Date.parse(redeemed?.at ?? '')).toBeGreaterThanOrEqual(Date.parse(approved?.at ?? ''));
  });
});

describe('a password reset ends every way in, approved sign-in requests included', () => {
  const worldWithAna = async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    return { ctx, ana, deps: authDepsOf(ctx), run: bindAuthRunEffects(ctx.authRunEffects) };
  };

  it('expires an approved, unredeemed sign-in request, so redeeming it mints nothing', async () => {
    const { ctx, ana, deps, run } = await worldWithAna();
    const started = (
      await run(() => startGrant(deps, { client: { name: 't', version: '1' }, profile: 'p', channel: 'stdio' }))
    )._unsafeUnwrap();
    const approval = approvalFor(started.userCode);
    const anaSession = await sessionPrincipalFor(ctx, ana.userId);
    (await run(() => approveGrant(deps, anaSession, approval)))._unsafeUnwrap();

    const reset = await run(() => resetPassword(deps, { username: 'ana', password: 'a brand new passphrase' }));

    expect(reset.isOk()).toBe(true);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: GrantStatus.enum.expired }]);
    const redeemed = (await run(() => redeemGrant(deps, started.deviceCode)))._unsafeUnwrap();
    expect(redeemed.kind).not.toBe('signed_in');
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
    const principal = await sessionPrincipalFor(ctx, ana.userId);
    const input = { userCode, access: 'read' as const, duration: '24h' as const, password: MEMBER_PASSWORD };

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

  it('refuses a sign-in approval retried through a session a password reset deleted, and mints nothing', async () => {
    const { ctx, owner } = await withOwner();
    const ana = await addUser(ctx, owner, 'ana');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const { session } = stdioSessionFor(ctx);
    const userCode = userCodeIn(await session.resolve());
    const principal = await sessionPrincipalFor(ctx, ana.userId);
    const input = approvalFor(userCode);

    const stale = (await approveGrant(deps, principal, input))._unsafeUnwrap();
    expect((await run(() => resetPassword(deps, { username: 'ana', password: 'a brand new passphrase' }))).isOk()).toBe(
      true,
    );
    expect(await ctx.db.all(sql`SELECT id FROM sessions WHERE user_id = ${ana.userId}`)).toEqual([]);
    let first = true;
    const approved = await run(() => {
      if (!first) return approveGrant(deps, principal, input);
      first = false;
      return okAsync(stale);
    });

    // The retry re-reads the approver's session, finds it gone and refuses — the same captured principal is not enough.
    expect(approved._unsafeUnwrapErr()).toEqual(authErrors.unauthenticated);
    expect(await ctx.db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: GrantStatus.enum.pending }]);
    const redeemed = (await session.resolve()).kind;
    expect(redeemed).toBe('not_signed_in');
    expect(await ctx.db.all(sql`SELECT * FROM access_tokens WHERE kind = 'stdio'`)).toEqual([]);
  });

  it('refuses an invitation sent by an admin who was demoted after it was authorized', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const actor: Actor = {
      kind: ActorKind.enum.session,
      principal: await sessionPrincipalFor(ctx, boss.userId, UserRole.enum.admin),
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

  it('refuses an invitation retried through an admin session that a disable and re-enable ended', async () => {
    const { ctx, owner } = await withOwner();
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const deps = authDepsOf(ctx);
    const run = bindAuthRunEffects(ctx.authRunEffects);
    const actor: Actor = {
      kind: ActorKind.enum.session,
      principal: await sessionPrincipalFor(ctx, boss.userId, UserRole.enum.admin),
      password: MEMBER_PASSWORD,
    };
    const input = { username: 'late-guest', role: UserRole.enum.member };

    const invitesBefore = await inviteRows(ctx);
    const stale = (await inviteUser(deps, actor, input))._unsafeUnwrap();
    await post(ctx, owner, `${USERS_URL}/${boss.userId}/disable`, { password: PASSWORD });
    await post(ctx, owner, `${USERS_URL}/${boss.userId}/enable`, { password: PASSWORD });
    // Same user, same password, active again — but the session the request came through is gone.
    expect(await ctx.db.all(sql`SELECT id FROM sessions WHERE user_id = ${boss.userId}`)).toEqual([]);
    let first = true;
    const invited = await run(() => {
      if (!first) return inviteUser(deps, actor, input);
      first = false;
      return okAsync(stale);
    });

    expect(invited._unsafeUnwrapErr()).toEqual(authErrors.unauthenticated);
    expect(await userRow(ctx, 'late-guest')).toBeUndefined();
    expect(await inviteRows(ctx)).toEqual(invitesBefore);
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
    const principal = await sessionPrincipalFor(ctx, ana.userId);
    const started = (
      await run(() => startGrant(deps, { client: { name: 't', version: '1' }, profile: 'p', channel: 'stdio' }))
    )._unsafeUnwrap();
    const input = {
      userCode: started.userCode,
      access: 'read' as const,
      duration: '30d' as const,
      password: MEMBER_PASSWORD,
    };
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
    ['no admin had changed the setting yet (the default row)', undefined],
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
    const principals = new Map([
      [rootId, await sessionPrincipalFor(ctx, rootId, UserRole.enum.admin)],
      [bossId, await sessionPrincipalFor(ctx, bossId, UserRole.enum.admin)],
    ]);
    const actor = (userId: string) => ({
      kind: 'session' as const,
      principal: principals.get(userId)!,
      password: PASSWORD,
    });

    // Both flows read "the other one is still an admin" BEFORE either commits …
    const staleRootDisablesBoss = (await disableUser(deps, actor(rootId), bossId))._unsafeUnwrap();
    const staleBossDisablesRoot = (await disableUser(deps, actor(bossId), rootId))._unsafeUnwrap();

    // … then they commit one after the other. The engine re-runs a flow whose reads went stale; the second re-run
    // sees the first's effect and is refused. Without the admins checked, both stale batches would
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
    expect(await ctx.db.all(sql`SELECT * FROM settings`)).toEqual([DEFAULT_SETTINGS_ROW]);
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
      url: `/ui/access/invite?code=${code}`,
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

  it('lives outside the one-segment dashboard namespace: a dashboard named "invite" still opens', async () => {
    const { ctx, owner } = await withOwner();
    const token = await mintFor(ctx, owner);
    const saved = await ctx.app.inject({
      method: 'POST',
      url: '/api/dashboards',
      headers: bearer(token.token),
      payload: { name: 'invite', html: '<section>MY DASHBOARD NAMED INVITE</section>' },
    });
    expect(saved.statusCode).toBeLessThan(300);

    const dashboard = await get(ctx, owner, '/ui/invite');
    expect(dashboard.statusCode).toBe(200);
    // The dashboard shell, not the claim page (the dashboard's own HTML is loaded into the shell afterwards).
    expect(dashboard.body).toContain('<title>PATTY</title>');
    expect(dashboard.body).not.toContain('Accept your invite');

    const claimPage = await ctx.app.inject({
      method: 'GET',
      url: '/ui/access/invite',
      headers: { host: LOOPBACK_HOST },
    });
    expect(claimPage.body).toContain('Accept your invite');
  });

  it('escapes whatever the link carries', async () => {
    const { ctx } = await withOwner();
    const shown = await ctx.app.inject({
      method: 'GET',
      url: `/ui/access/invite?code=${encodeURIComponent('"><script>alert(1)</script>')}`,
      headers: { host: LOOPBACK_HOST },
    });
    expect(shown.body).not.toContain('<script>');
    expect(shown.body).toContain('&lt;script&gt;');
  });

  it('is public, like /ui/setup, and shows no other page without a session', async () => {
    const { ctx } = await withOwner();
    const shown = await ctx.app.inject({ method: 'GET', url: '/ui/access/invite', headers: { host: LOOPBACK_HOST } });
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

describe('the sign-in cap', () => {
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
      { id: INSTANCE_SETTINGS_ID, max_sign_in_duration: '24h' },
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
      scopes: ['patty:read'],
      via: 'stdio',
    });
    expect(await ctx.db.all(sql`SELECT user_id FROM access_tokens WHERE kind = 'stdio'`)).toEqual([
      { user_id: ana.userId },
    ]);
  });
});
