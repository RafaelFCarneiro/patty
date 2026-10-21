import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES } from '../../../src/diplomat/http/auth-paths.js';
import { AuthMode } from '../../../src/models/auth/mode.js';
import { UserRole } from '../../../src/models/auth/owner.js';
import { OWNER_PRINCIPAL, PrincipalVia } from '../../../src/models/auth/principal.js';
import { ALL_SCOPES } from '../../../src/models/auth/scope.js';
import {
  claimOwner,
  FORM_HEADERS,
  formBody,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  PASSWORD,
  useAuthApp,
  USERNAME,
} from './helpers.js';

const createApp = useAuthApp();

type RegisteredRoute = { method: string; url: string };

/** Every (method, url) Fastify actually registered — captured by an `onRoute` listener attached BEFORE the
 *  routes exist, so a route added tomorrow in any module appears here without anyone updating a list. */
const registeredRoutes = async (ctx: Awaited<ReturnType<typeof createApp>>): Promise<RegisteredRoute[]> => {
  const probe = Fastify();
  const routes: RegisteredRoute[] = [];
  probe.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push({ method, url: route.url });
  });
  ctx.registerOn(probe);
  await probe.ready();
  await probe.close();
  return routes;
};

const concrete = (url: string): string => url.replace(/:[A-Za-z]+/g, 'x').replace('*', 'x');
const isPublic = ({ method, url }: RegisteredRoute): boolean => PUBLIC_ROUTES[url]?.includes(method) ?? false;

describe('auth hook — required mode', () => {
  it('protects EVERY registered route outside the public allowlist', async () => {
    const ctx = await createApp();
    const routes = await registeredRoutes(ctx);

    // Sanity: the capture really saw the whole surface, not an empty list that passes vacuously.
    const urls = routes.map(({ url }) => url);
    expect(routes.length).toBeGreaterThan(60);
    expect(urls).toEqual(expect.arrayContaining(['/mcp', '/api/status', '/api/accounts', '/ui', '/ui/events']));
    expect(urls).toEqual(expect.arrayContaining(Object.keys(PUBLIC_ROUTES)));

    const exposed: string[] = [];
    for (const route of routes.filter((candidate) => !isPublic(candidate))) {
      const res = await ctx.app.inject({ method: route.method as 'GET', url: concrete(route.url) });
      const rejected =
        res.statusCode === 401 || (res.statusCode === 303 && /^\/ui\/(setup|login)/.test(String(res.headers.location)));
      if (!rejected) exposed.push(`${route.method} ${route.url} → ${res.statusCode}`);
    }
    expect(exposed).toEqual([]);
  });

  it('answers /api and /mcp with 401 JSON and /ui with a redirect', async () => {
    const ctx = await createApp();
    const api = await ctx.app.inject({ method: 'GET', url: '/api/status' });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toEqual({ error: { code: 'unauthenticated' } });

    const mcp = await ctx.app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(mcp.statusCode).toBe(401);

    const ui = await ctx.app.inject({ method: 'GET', url: '/ui/overview' });
    expect(ui.statusCode).toBe(303);
    expect(ui.headers.location).toBe('/ui/setup');
  });

  it('sends an unauthenticated browser to login once the owner is claimed, remembering its page', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/ui/budget?month=3' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`/ui/login?next=${encodeURIComponent('/ui/budget?month=3')}`);
  });

  it('does not reveal which paths exist: an unknown path is 401 too', async () => {
    const ctx = await createApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/definitely/not/a/route' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health/../status' })).statusCode).toBe(401);
  });

  it('keeps exactly the allowlisted routes public', async () => {
    const ctx = await createApp();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ status: 'ok', db: 'ok' });
    expect((await ctx.app.inject({ method: 'GET', url: '/ui/assets/app.css' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/ui/setup' })).statusCode).toBe(200);
    for (const protectedPath of ['/ui/assets/app.js', '/ui/assets/money.js', '/api/openapi.json', '/api/preferences']) {
      expect((await ctx.app.inject({ method: 'GET', url: protectedPath })).statusCode, protectedPath).not.toBe(200);
    }
  });

  it('resolves the owner as the principal for an authenticated request', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const probe = Fastify();
    ctx.registerOn(probe);
    probe.get('/__principal', async (req) => req.principal ?? null);
    const res = await probe.inject({ method: 'GET', url: '/__principal', headers: { cookie } });
    expect(res.json()).toEqual({
      userId: OWNER_PRINCIPAL.userId,
      role: UserRole.enum.admin,
      scopes: [...ALL_SCOPES],
      via: PrincipalVia.enum.session,
      sessionId: expect.any(String),
    });
    await probe.close();
  });
});

describe('auth hook — disabled mode', () => {
  it('serves every route without a session, acting as the owner', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    expect(ctx.auth.mode).toBe(AuthMode.enum.disabled);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/ui' })).statusCode).toBe(200);

    const probe = Fastify();
    ctx.registerOn(probe);
    probe.get('/__principal', async (req) => req.principal ?? null);
    expect((await probe.inject({ method: 'GET', url: '/__principal' })).json()).toEqual(OWNER_PRINCIPAL);
    await probe.close();
  });

  it('registers no login or setup pages and no logout control', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    expect((await ctx.app.inject({ method: 'GET', url: '/ui/login' })).statusCode).toBe(200); // the SPA shell
    expect((await ctx.app.inject({ method: 'POST', url: '/ui/login' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/ui' })).body).not.toContain('/ui/logout');
  });
});

describe('logout control in the shell', () => {
  it('is present when sessions are required', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/ui', headers: { cookie } });
    expect(res.body).toContain('action="/ui/logout"');
    expect(res.body).not.toContain('fintrack:auth-controls');
  });
});

describe('CSRF', () => {
  const unsafe = (ctx: Awaited<ReturnType<typeof createApp>>, cookie: string, headers: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { cookie, host: LOOPBACK_HOST, 'content-type': 'application/json', ...headers },
      payload: { name: 'Csrf probe', type: 'checking', currency: 'USD' },
    });

  it('rejects a cross-origin unsafe request that carries the session cookie', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await unsafe(ctx, cookie, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_origin');
  });

  it('rejects an unsafe request that declares no origin at all', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    expect((await unsafe(ctx, cookie, {})).statusCode).toBe(403);
  });

  it('rejects origin "null" and a lookalike host', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    expect((await unsafe(ctx, cookie, { origin: 'null' })).statusCode).toBe(403);
    expect((await unsafe(ctx, cookie, { origin: `${LOOPBACK_ORIGIN}.evil.example` })).statusCode).toBe(403);
  });

  it('allows a same-origin unsafe request, via Origin or via Referer', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    expect((await unsafe(ctx, cookie, { origin: LOOPBACK_ORIGIN })).statusCode).toBe(201);
    expect((await unsafe(ctx, cookie, { referer: `${LOOPBACK_ORIGIN}/ui/accounts`, 'x-n': '2' })).statusCode).toBe(409);
  });

  it('applies to POST /mcp as well', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const headers = {
      cookie,
      host: LOOPBACK_HOST,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    // Malformed JSON: a same-origin request clears the gate and is then refused by body parsing (400), so the
    // MCP handler never runs — its transport arms a socket timer that light-my-request's fake socket can't
    // service (the real initialize round-trip is covered by scripts/docker-smoke.sh).
    const send = (origin: string) =>
      ctx.app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, origin }, payload: '{' });

    expect((await send('https://evil.example')).statusCode).toBe(403);
    expect((await send(LOOPBACK_ORIGIN)).statusCode).toBe(400);
  });

  it('leaves safe methods alone', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { cookie, host: LOOPBACK_HOST, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('expects PUBLIC_URL when set — and still accepts the loopback host it was reached on', async () => {
    const publicUrl = 'https://fintrack.example.com';
    const ctx = await createApp({ auth: { PUBLIC_URL: publicUrl } });
    const cookie = await claimOwner(ctx).catch(() => '');
    // claimOwner posts from the loopback origin, which stays valid alongside PUBLIC_URL.
    expect(cookie).not.toBe('');
    expect((await unsafe(ctx, cookie, { origin: publicUrl, host: 'fintrack.example.com' })).statusCode).toBe(201);
    expect((await unsafe(ctx, cookie, { origin: LOOPBACK_ORIGIN })).statusCode).toBe(409);
    expect(
      (await unsafe(ctx, cookie, { origin: 'https://evil.example', host: 'fintrack.example.com' })).statusCode,
    ).toBe(403);
  });

  it('refuses unsafe cookie requests when no origin can be established (non-loopback Host)', async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const res = await unsafe(ctx, cookie, { host: 'fintrack.lan:51737', origin: 'http://fintrack.lan:51737' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.hint).toContain('PUBLIC_URL');
  });

  it('guards the pre-session POSTs against a cross-site browser, leaving header-less clients alone', async () => {
    const ctx = await createApp();
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/ui/login',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: 'https://evil.example' },
      payload: formBody({ username: USERNAME, password: PASSWORD }),
    });
    expect(forged.statusCode).toBe(403);
    const scripted = await ctx.app.inject({
      method: 'POST',
      url: '/ui/login',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST },
      payload: formBody({ username: USERNAME, password: PASSWORD }),
    });
    expect(scripted.statusCode).toBe(401);
  });
});
