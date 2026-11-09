import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerTokenRoutes } from '../../../src/diplomat/http/routes/tokens.js';
import { authErrors } from '../../../src/models/auth/errors.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { OWNER_PRINCIPAL, PrincipalVia } from '../../../src/models/auth/principal.js';
import { Scope } from '../../../src/models/auth/scope.js';
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
  useAuthApp,
} from './helpers.js';
import '../../../src/diplomat/http/principal.js';

const createApp = useAuthApp();

describe('a bearer token can never reach token management', () => {
  // Path tricks that could make a request look like /api or /mcp to the hook while routing to a /ui page.
  const TRICKS = [
    '/api/../ui/access/tokens',
    '/mcp/../ui/access/tokens',
    '/api/%2e%2e/ui/access/tokens',
    '/api/..%2fui/tokens',
    '//ui/access/tokens',
    '/ui/access/tokens/',
    '/ui//tokens',
    '/UI/tokens',
    '/api/./../ui/access/tokens',
  ];

  it.each(TRICKS)('%s with a write token never lists, mints or revokes', async (url) => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const victim = await mintToken(ctx, cookie, { name: 'victim', access: 'read' });
    const attacker = await mintToken(ctx, cookie, { name: 'attacker', access: 'write' });
    // Using a token legitimately records last_used_at; nothing else about any token may change.
    const snapshot = async () =>
      (await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID)).map(
        ({ lastUsedAt: _used, version: _v, ...rest }) => rest,
      );
    const before = await snapshot();

    const headers = { host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN, ...bearer(attacker.token) };
    const form = { ...headers, 'content-type': 'application/x-www-form-urlencoded' };
    const responses = [
      await ctx.app.inject({ method: 'GET', url, headers }),
      await ctx.app.inject({
        method: 'POST',
        url,
        headers: form,
        payload: 'password=x&name=evil&access=write&expiry=30',
      }),
      await ctx.app.inject({ method: 'POST', url: url.replace('tokens', `tokens/${victim.id}/revoke`), headers: form }),
    ];
    for (const res of responses) {
      expect(res.body, url).not.toContain('Access tokens');
      expect(res.body, url).not.toMatch(/data-testid="token-secret"/);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('the token routes themselves insist on a session, even if the hook ever let a token through', async () => {
    const app = Fastify();
    // Stands in for a (hypothetical) hook that authenticated a token on a /ui path.
    app.addHook('onRequest', async (req) => {
      req.principal = {
        ...OWNER_PRINCIPAL,
        scopes: [Scope.enum['patty:write']],
        via: PrincipalVia.enum.token,
        tokenId: 't',
      };
    });
    registerTokenRoutes(app, { deps: {} as never, runEffects: (() => undefined) as never, secureCookie: false });
    await app.ready();

    for (const [method, url] of [
      ['GET', '/ui/access/tokens'],
      ['POST', '/ui/access/tokens'],
      ['POST', '/ui/access/tokens/abc/revoke'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: method === 'POST' ? 'name=x' : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toEqual({ error: authErrors.sessionRequired });
    }
    await app.close();
  });
});

describe('a script running in the dashboard origin cannot mint itself a token', () => {
  // A write token can save a dashboard whose <script> runs in /ui, with the owner's session cookie and a same-origin
  // Origin on every fetch. It holds no password, so the step-up on POST /ui/access/tokens is what stops it.
  it('is refused without — or with a wrong — password, and nothing is created', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const before = await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID);

    for (const password of [undefined, '', 'not the password']) {
      const fields: Record<string, string> = { name: 'from-script', access: 'write', expiry: '30' };
      if (password !== undefined) fields.password = password;
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/ui/access/tokens',
        headers: browserHeaders(cookie),
        payload: formBody(fields),
      });
      expect(res.statusCode, String(password)).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toMatch(/data-testid="token-secret"/);
    }
    expect(await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID)).toEqual(before);
  });

  it('a wrong password says so, with a 403, and the right one still works afterwards', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens',
      headers: browserHeaders(cookie),
      payload: formBody({ password: 'nope nope nope', name: 'x', access: 'read', expiry: '30' }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).toContain('That password is not correct.');
    expect((await mintToken(ctx, cookie)).token).toMatch(/^ptk_/);
  });

  it('guessing the password is throttled like a login', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const guess = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/ui/access/tokens',
        headers: browserHeaders(cookie),
        payload: formBody({ password: 'guess guess guess', name: 'x', access: 'read', expiry: '30' }),
      });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) statuses.push((await guess()).statusCode);
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses[5]).toBe(429);
    // Even the right password is refused until the window clears.
    const right = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens',
      headers: browserHeaders(cookie),
      payload: formBody({ password: PASSWORD, name: 'x', access: 'read', expiry: '30' }),
    });
    expect(right.statusCode).toBe(429);
  });
});

describe('credential classification follows the route the router matched', () => {
  it('a bad bearer on a percent-encoded /api path is 401, never a fallback to a valid session cookie', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const headers = { host: LOOPBACK_HOST, cookie };

    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers })).statusCode).toBe(200);
    for (const url of ['/api/status', '/%61pi/status']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { ...headers, authorization: 'Bearer ptk_bad' },
      });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: { code: 'invalid_token' } });
    }
  });

  it('a valid bearer works on the encoded path too, and a bearer never works on an encoded /ui path', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { token } = await mintToken(ctx, cookie, { access: 'write' });
    const headers = { host: LOOPBACK_HOST, ...bearer(token) };

    expect((await ctx.app.inject({ method: 'GET', url: '/%61pi/status', headers })).statusCode).toBe(200);
    for (const url of ['/%75i/access/tokens', '/ui/access/%74okens']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body, url).not.toContain('Access tokens');
    }
  });
});
