import Fastify, { type FastifyInstance } from 'fastify';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthDeps } from '../../../../../src/controllers/deps.js';
import { DISABLED_AUTH, type HttpAuth } from '../../../../../src/diplomat/http/context.js';
import { SESSION_COOKIE_NAME } from '../../../../../src/diplomat/http/cookies.js';
import { registerAuthHook } from '../../../../../src/diplomat/http/hooks/auth.js';
import { conflict } from '../../../../../src/models/error.js';
import { AUTH_MESSAGES } from '../../../../../src/models/auth/message.js';
import { AuthMode } from '../../../../../src/models/auth/mode.js';
import { OWNER_USER_ID, UserRole } from '../../../../../src/models/auth/owner.js';
import { OWNER_PRINCIPAL, type Principal, PrincipalVia } from '../../../../../src/models/auth/principal.js';
import { ALL_SCOPES } from '../../../../../src/models/auth/scope.js';

// The hook only translates: headers/route/cookie in, 401 / 403 / redirect / principal out. The decisions are
// unit-tested in test/unit/logic/auth.test.ts; the whole stack is covered by test/integration/auth/*.
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const build = async (auth: HttpAuth): Promise<FastifyInstance> => {
  const app = Fastify();
  apps.push(app);
  registerAuthHook(app, auth);
  app.get('/api/probe', async (req) => ({ principal: req.principal ?? null }));
  app.post('/api/probe', async (req) => ({ principal: req.principal ?? null }));
  app.get('/ui/probe', async () => 'ui');
  await app.ready();
  return app;
};

const sessionPrincipalOf = (userId: string, role: UserRole): Principal => ({
  userId,
  role,
  scopes: [...ALL_SCOPES],
  via: PrincipalVia.enum.session,
});

const unclaimedOwner = { id: OWNER_USER_ID, username: null, passwordHash: null };
const required = (principal: Principal | null | 'fails', ownerUnclaimed = true): HttpAuth => ({
  mode: AuthMode.enum.required,
  secureCookie: false,
  deps: {
    users: {
      findById: async () => (ownerUnclaimed ? unclaimedOwner : { ...unclaimedOwner, username: 'x', passwordHash: 'h' }),
    },
    secrets: { hashSecret: (secret: string) => `sha(${secret})` },
  } as unknown as AuthDeps,
  runEffects: (() => (principal === 'fails' ? errAsync(conflict) : okAsync(principal))) as never,
});

const withSession = { cookie: `${SESSION_COOKIE_NAME}=token` };

describe('registerAuthHook — auth disabled', () => {
  it('acts as the owner for a loopback request', async () => {
    const app = await build(DISABLED_AUTH);
    const res = await app.inject({ method: 'GET', url: '/api/probe', headers: { host: '127.0.0.1:3001' } });
    expect(res.json()).toEqual({ principal: OWNER_PRINCIPAL });
  });

  it('answers 403 forbidden_origin with the constant hint for a rebound Host or a foreign Origin', async () => {
    const app = await build(DISABLED_AUTH);
    for (const headers of [{ host: 'attacker.example' }, { host: '127.0.0.1:3001', origin: 'https://evil.example' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/probe', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: { code: 'forbidden_origin', hint: AUTH_MESSAGES.nonLoopbackRequest } });
    }
  });
});

describe('registerAuthHook — auth required', () => {
  it('401 JSON for /api without a valid session', async () => {
    const app = await build(required(null));
    const res = await app.inject({ method: 'GET', url: '/api/probe', headers: withSession });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthenticated' } });
  });

  it('401 JSON for /api when no cookie is sent at all', async () => {
    const app = await build(required(null));
    expect((await app.inject({ method: 'GET', url: '/api/probe' })).statusCode).toBe(401);
  });

  it('redirects /ui to setup while unclaimed, and to login (remembering the page) once claimed', async () => {
    const unclaimed = await build(required(null, true));
    const toSetup = await unclaimed.inject({ method: 'GET', url: '/ui/probe' });
    expect(toSetup.statusCode).toBe(303);
    expect(toSetup.headers.location).toBe('/ui/setup');

    const claimed = await build(required(null, false));
    const toLogin = await claimed.inject({ method: 'GET', url: '/ui/probe?tab=2' });
    expect(toLogin.statusCode).toBe(303);
    expect(toLogin.headers.location).toBe(`/ui/login?next=${encodeURIComponent('/ui/probe?tab=2')}`);
  });

  it('sets the resolved principal for a valid session', async () => {
    const principal = sessionPrincipalOf('u1', UserRole.enum.member);
    const app = await build(required(principal));
    const res = await app.inject({ method: 'GET', url: '/api/probe', headers: withSession });
    expect(res.json()).toEqual({ principal });
  });

  it('answers a failed session lookup with that error, never as an anonymous pass', async () => {
    const app = await build(required('fails'));
    const res = await app.inject({ method: 'GET', url: '/api/probe', headers: withSession });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: conflict });
  });

  it('refuses a cookie-authenticated cross-origin write with 403 and lets a same-origin one through', async () => {
    const principal = sessionPrincipalOf('u1', UserRole.enum.admin);
    const app = await build(required(principal));
    const base = { ...withSession, host: '127.0.0.1:51737' };
    const crossSite = await app.inject({
      method: 'POST',
      url: '/api/probe',
      headers: { ...base, origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe('forbidden_origin');
    const sameSite = await app.inject({
      method: 'POST',
      url: '/api/probe',
      headers: { ...base, origin: 'http://127.0.0.1:51737' },
    });
    expect(sameSite.statusCode).toBe(200);
  });
});
