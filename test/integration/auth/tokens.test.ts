import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SESSION_TOUCH_INTERVAL_MS } from '../../../src/logic/auth.js';
import { AuthMode, MCP_PRM_PATH, OWNER_USER_ID } from '../../../src/models/auth.js';
import {
  authDepsOf,
  bearer,
  browserHeaders,
  claimOwner,
  concreteUrl,
  INITIALIZE_REQUEST,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  MCP_HEADERS,
  mintToken,
  PASSWORD,
  registeredRoutes,
  toolCall,
  useAuthApp,
} from './helpers.js';
import { PUBLIC_ROUTES } from '../../../src/diplomat/http/authPaths.js';

const createApp = useAuthApp();

const METADATA_URL = `${LOOPBACK_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const BASE_HEADERS = { host: LOOPBACK_HOST };
const ACCOUNT = { name: 'Checking', type: 'checking', initialBalance: 100, currency: 'USD' };

const challengeOf = (res: { headers: Record<string, unknown> }): string => String(res.headers['www-authenticate']);

/** An app with the owner claimed, plus a read-only and a read+write token. */
const world = async () => {
  const ctx = await createApp();
  const cookie = await claimOwner(ctx);
  const reader = await mintToken(ctx, cookie, { name: 'reader', access: 'read' });
  const writer = await mintToken(ctx, cookie, { name: 'writer', access: 'write' });
  return { ctx, cookie, reader, writer };
};

describe('no credential on /api or /mcp', () => {
  it('answers 401 with a Bearer challenge naming the metadata URL and every scope', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    for (const [method, url] of [
      ['GET', '/api/status'],
      ['POST', '/mcp'],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: BASE_HEADERS,
        payload: method === 'POST' ? {} : undefined,
      });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthenticated' } });
      expect(challengeOf(res)).toBe(`Bearer resource_metadata="${METADATA_URL}", scope="fintrack:read fintrack:write"`);
    }
  });

  it('challenges EVERY registered route outside the public allowlist', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const routes = await registeredRoutes(ctx);
    const unchallenged: string[] = [];
    for (const route of routes) {
      if (PUBLIC_ROUTES[route.url]?.includes(route.method) || route.url.startsWith('/ui')) continue;
      const res = await ctx.app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        headers: BASE_HEADERS,
      });
      if (res.statusCode !== 401 || !challengeOf(res).includes(`resource_metadata="${METADATA_URL}"`)) {
        unchallenged.push(`${route.method} ${route.url} → ${res.statusCode}`);
      }
    }
    expect(unchallenged).toEqual([]);
    expect(routes.map(({ url }) => url)).toEqual(expect.arrayContaining(['/mcp', '/api/accounts']));
  });

  it('leaves resource_metadata out when the instance cannot name its own origin', async () => {
    const ctx = await createApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { host: 'fin.lan:51737' } });
    expect(res.statusCode).toBe(401);
    expect(challengeOf(res)).toBe('Bearer scope="fintrack:read fintrack:write"');
  });
});

describe('credential precedence on /api and /mcp', () => {
  it('a valid bearer authenticates, with no cookie', async () => {
    const { ctx, writer } = await world();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { ...BASE_HEADERS, ...bearer(writer.token) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a valid bearer wins over a bad cookie', async () => {
    const { ctx, writer } = await world();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { ...BASE_HEADERS, ...bearer(writer.token), cookie: 'fintrack_session=garbage' },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['an unknown token', 'Bearer ftk_unknownunknownunknownunknownunknownunknown1'],
    ['a malformed header', 'Basic Zm9vOmJhcg=='],
    ['an empty bearer', 'Bearer '],
    ['a bearer that is not ours', 'Bearer not-an-ftk-token'],
  ])('%s is 401 invalid_token — and a valid session cookie is NOT used instead', async (_label, authorization) => {
    const { ctx, cookie } = await world();
    for (const [method, url] of [
      ['GET', '/api/status'],
      ['POST', '/mcp'],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: { ...BASE_HEADERS, origin: LOOPBACK_ORIGIN, authorization, cookie },
        payload: method === 'POST' ? INITIALIZE_REQUEST : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'invalid_token' } });
      expect(challengeOf(res)).toBe(`Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`);
    }
  });

  it('the cookie alone still works as before', async () => {
    const { ctx, cookie } = await world();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { ...BASE_HEADERS, cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('a revoked token is 401 invalid_token at once', async () => {
    const { ctx, cookie, writer } = await world();
    const headers = { ...BASE_HEADERS, ...bearer(writer.token) };
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers })).statusCode).toBe(200);

    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/ui/access/tokens/${writer.id}/revoke`,
      headers: browserHeaders(cookie),
    });
    expect(revoke.statusCode).toBe(303);

    const after = await ctx.app.inject({ method: 'GET', url: '/api/status', headers });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toEqual({ error: { code: 'invalid_token' } });
    // The row is kept, marked revoked.
    expect((await authDepsOf(ctx).accessTokens.findById(OWNER_USER_ID, writer.id))?.revokedAt).not.toBeNull();
  });

  it('an expired token is 401 invalid_token', async () => {
    const { ctx, writer } = await world();
    await ctx.db.run(sql`UPDATE access_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ${writer.id}`);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { ...BASE_HEADERS, ...bearer(writer.token) },
    });
    expect(res.statusCode).toBe(401);
    expect(challengeOf(res)).toContain('error="invalid_token"');
  });

  it('records last_used_at on first use and then leaves it alone inside the throttle window', async () => {
    const { ctx, writer } = await world();
    const stored = () => authDepsOf(ctx).accessTokens.findById(OWNER_USER_ID, writer.id);
    expect((await stored())?.lastUsedAt).toBeNull();

    const call = () =>
      ctx.app.inject({ method: 'GET', url: '/api/status', headers: { ...BASE_HEADERS, ...bearer(writer.token) } });
    await call();
    const first = (await stored())?.lastUsedAt;
    expect(first).toEqual(expect.any(String));
    await call();
    expect((await stored())?.lastUsedAt).toBe(first);
    expect(SESSION_TOUCH_INTERVAL_MS).toBeGreaterThan(1000);
  });
});

describe('bearer is not a browser credential', () => {
  it('is not accepted on /ui — which stays session-only', async () => {
    const { ctx, writer } = await world();
    for (const url of ['/ui', '/ui/overview', '/ui/access/tokens', '/ui/events']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: { ...BASE_HEADERS, ...bearer(writer.token) } });
      expect(res.statusCode, url).toBe(303);
      expect(String(res.headers.location)).toMatch(/^\/ui\/login/);
    }
  });

  it('ignores a bad Authorization header on /ui when a valid session cookie is present', async () => {
    const { ctx, cookie } = await world();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/ui/access/tokens',
      headers: { ...BASE_HEADERS, cookie, authorization: 'Bearer garbage' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('is exempt from the CSRF Origin check — it carries no ambient credential — while a cookie is not', async () => {
    const { ctx, cookie, writer } = await world();
    const hostile = { ...BASE_HEADERS, origin: 'https://evil.example', 'content-type': 'application/json' };

    const viaBearer = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { ...hostile, ...bearer(writer.token) },
      payload: ACCOUNT,
    });
    expect(viaBearer.statusCode).toBe(201);

    const viaCookie = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { ...hostile, cookie },
      payload: { ...ACCOUNT, name: 'Other' },
    });
    expect(viaCookie.statusCode).toBe(403);
    expect(viaCookie.json().error.code).toBe('forbidden_origin');
  });
});

describe('token management is session-only', () => {
  it('a bearer token can neither mint, list nor revoke tokens', async () => {
    const { ctx, writer, reader } = await world();
    const before = await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID);
    const headers = { ...BASE_HEADERS, origin: LOOPBACK_ORIGIN, ...bearer(writer.token) };

    const mint = await ctx.app.inject({
      method: 'POST',
      url: '/ui/access/tokens',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `password=${PASSWORD}&name=sneaky&access=write&expiry=none`,
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/ui/access/tokens', headers });
    const revoke = await ctx.app.inject({ method: 'POST', url: `/ui/access/tokens/${reader.id}/revoke`, headers });
    for (const res of [mint, list, revoke]) {
      expect(res.statusCode).toBe(303);
      expect(String(res.headers.location)).toMatch(/^\/ui\/login/);
    }

    const after = await authDepsOf(ctx).accessTokens.listByUser(OWNER_USER_ID);
    expect(after).toEqual(before);
    expect(after.every(({ revokedAt }) => revokedAt === null)).toBe(true);
  });

  it('there is no /api or /mcp route that manages tokens', async () => {
    const { ctx } = await world();
    const urls = (await registeredRoutes(ctx)).map(({ url }) => url);
    expect(urls.filter((url) => /token/i.test(url) && !url.startsWith('/ui/'))).toEqual([]);
  });
});

describe('REST scopes', () => {
  it('a read token reads but cannot write; the refusal is a 403 insufficient_scope challenge', async () => {
    const { ctx, reader } = await world();
    const headers = { ...BASE_HEADERS, ...bearer(reader.token), 'content-type': 'application/json' };

    expect((await ctx.app.inject({ method: 'GET', url: '/api/accounts', headers })).statusCode).toBe(200);

    const write = await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers, payload: ACCOUNT });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: { code: 'insufficient_scope', scope: 'fintrack:write' } });
    expect(challengeOf(write)).toBe(
      `Bearer error="insufficient_scope", scope="fintrack:write", resource_metadata="${METADATA_URL}"`,
    );
    expect(((await ctx.app.inject({ method: 'GET', url: '/api/accounts', headers })).json() as unknown[]).length).toBe(
      0,
    );
  });

  it('a read token cannot perform ANY non-GET /api route', async () => {
    const { ctx, reader } = await world();
    const allowed: string[] = [];
    for (const route of (await registeredRoutes(ctx)).filter(
      ({ url, method }) => url.startsWith('/api/') && method !== 'GET' && method !== 'HEAD',
    )) {
      const res = await ctx.app.inject({
        method: route.method as 'POST',
        url: concreteUrl(route.url),
        headers: { ...BASE_HEADERS, ...bearer(reader.token), 'content-type': 'application/json' },
        payload: {},
      });
      if (res.statusCode !== 403) allowed.push(`${route.method} ${route.url} → ${res.statusCode}`);
    }
    expect(allowed).toEqual([]);
  });

  it('a write token can read and write', async () => {
    const { ctx, writer } = await world();
    const headers = { ...BASE_HEADERS, ...bearer(writer.token), 'content-type': 'application/json' };
    expect((await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers, payload: ACCOUNT })).statusCode).toBe(
      201,
    );
    expect((await ctx.app.inject({ method: 'GET', url: '/api/accounts', headers })).statusCode).toBe(200);
  });

  it('GET /api/openapi.json is readable with a read token', async () => {
    const { ctx, reader } = await world();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/openapi.json',
      headers: { ...BASE_HEADERS, ...bearer(reader.token) },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('MCP scopes over HTTP', () => {
  // Calls that reach the SDK transport go over a real socket: it streams through node's own request/response.
  const serve = async (ctx: Awaited<ReturnType<typeof world>>['ctx']): Promise<string> => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    return `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
  };
  const post = async (base: string, token: string, body: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, challenge: res.headers.get('www-authenticate'), text: await res.text() };
  };
  const accountsOf = async (base: string, token: string): Promise<string[]> => {
    const res = await fetch(`${base}/api/accounts`, { headers: { authorization: `Bearer ${token}` } });
    return ((await res.json()) as { name: string }[]).map(({ name }) => name);
  };
  const insufficient = (base: string) =>
    `Bearer error="insufficient_scope", scope="fintrack:write", resource_metadata="${base}${MCP_PRM_PATH}"`;

  it('a read token can initialize and call a read tool', async () => {
    const { ctx, reader } = await world();
    const base = await serve(ctx);
    const init = await post(base, reader.token, INITIALIZE_REQUEST);
    expect(init.status).toBe(200);
    expect(init.text).toContain('"result"');

    const list = await post(base, reader.token, toolCall('list_accounts'));
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('insufficient_scope');
  });

  it('a read token calling a write tool is refused 403 before the tool runs', async () => {
    const { ctx, reader } = await world();
    const base = await serve(ctx);
    const res = await post(base, reader.token, toolCall('create_account', ACCOUNT));
    expect(res.status).toBe(403);
    expect(res.challenge).toBe(insufficient(base));
    expect(await accountsOf(base, reader.token)).toEqual([]);
  });

  it.each(['create_account', 'delete_account', 'apply_due_recurring', 'set_locale', 'no_such_tool'])(
    'a read token cannot call %s',
    async (name) => {
      const { ctx, reader } = await world();
      const base = await serve(ctx);
      expect((await post(base, reader.token, toolCall(name, { name: 'x' }))).status).toBe(403);
    },
  );

  it('a batch containing one write call is refused as a whole', async () => {
    const { ctx, reader } = await world();
    const base = await serve(ctx);
    const res = await post(base, reader.token, [
      toolCall('list_accounts', {}, 2),
      toolCall('create_account', ACCOUNT, 3),
    ]);
    expect(res.status).toBe(403);
    expect(await accountsOf(base, reader.token)).toEqual([]);
  });

  it('a write token calls a write tool', async () => {
    const { ctx, writer } = await world();
    const base = await serve(ctx);
    const res = await post(base, writer.token, toolCall('create_account', ACCOUNT));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('insufficient_scope');
    expect(await accountsOf(base, writer.token)).toEqual(['Checking']);
  });

  it('a revoked token is 401 invalid_token on /mcp too', async () => {
    const { ctx, cookie, writer } = await world();
    const base = await serve(ctx);
    await ctx.app.inject({
      method: 'POST',
      url: `/ui/access/tokens/${writer.id}/revoke`,
      headers: browserHeaders(cookie),
    });
    const res = await post(base, writer.token, INITIALIZE_REQUEST);
    expect(res.status).toBe(401);
    expect(res.challenge).toBe(`Bearer error="invalid_token", resource_metadata="${base}${MCP_PRM_PATH}"`);
  });

  it('works with a real MCP client sending the bearer header: read tools yes, write tools no', async () => {
    const { ctx, reader, writer } = await world();
    const base = await serve(ctx);
    const connect = async (token: string) => {
      const client = new Client({ name: 'fintrack-test', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    };

    const writing = await connect(writer.token);
    const created = await writing.callTool({ name: 'create_account', arguments: ACCOUNT });
    expect(created.isError).toBeFalsy();
    expect((await writing.listTools()).tools).toHaveLength(55);
    await writing.close();

    const reading = await connect(reader.token);
    const listed = await reading.callTool({ name: 'list_accounts', arguments: {} });
    expect(JSON.stringify(listed.content)).toContain('Checking');
    await expect(reading.callTool({ name: 'delete_account', arguments: { name: 'Checking' } })).rejects.toThrow(
      /insufficient_scope/,
    );
    await reading.close();
    expect(await accountsOf(base, writer.token)).toEqual(['Checking']);
  });
});

describe('auth disabled (the npm loopback default)', () => {
  it('ignores an Authorization header entirely and acts as the owner', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    for (const authorization of ['Bearer ftk_whatever', 'Bearer garbage', 'Basic Zm9v', '']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { ...BASE_HEADERS, authorization },
      });
      expect(res.statusCode, authorization).toBe(200);
    }
    const write = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { ...BASE_HEADERS, authorization: 'Bearer ftk_nope', 'content-type': 'application/json' },
      payload: ACCOUNT,
    });
    expect(write.statusCode).toBe(201);
  });

  it('serves no token pages and no resource metadata', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/ui/access/tokens', headers: BASE_HEADERS })).statusCode,
    ).toBe(404);
    for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: BASE_HEADERS })).statusCode, url).toBe(404);
    }
  });

  it('lets an MCP tool call through as the owner, with every scope', async () => {
    const ctx = await createApp({ auth: { FINTRACK_AUTH: AuthMode.enum.disabled } });
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: 'Bearer ftk_ignored' },
      body: JSON.stringify(toolCall('create_account', ACCOUNT)),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('insufficient_scope');
  });
});
