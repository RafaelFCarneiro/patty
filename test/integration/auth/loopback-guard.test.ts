import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { AUTH_MESSAGES } from '../../../src/models/auth/message.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { concreteUrl, registeredRoutes } from './helpers.js';

// Auth DISABLED (the npm default). Every request acts as the owner, so a request that is not demonstrably from
// this machine — a DNS-rebound Host, a cross-site Origin — must be refused on every route and method.
const ATTACKER_HOSTS = ['attacker.example', 'attacker.example:3001', '127.0.0.1.attacker.example'];
const LOOPBACK_HOSTS = ['127.0.0.1:51737', 'localhost:51737', '[::1]:51737'];
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

let tmpDir: string;
let ctx: AppContext;
let port: number;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-loopback-guard-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') }); // no `auth` option: disabled mode
  await ctx.app.listen({ port: 0, host: LOOPBACK_HOST });
  port = (ctx.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A real HTTP request with exactly the headers given — `inject` cannot omit Host. */
const wire = (opts: { method: string; path: string; headers: Record<string, string>; body?: unknown }) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      {
        host: LOOPBACK_HOST,
        port,
        method: opts.method,
        path: opts.path,
        headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });

/** HTTP/1.0 allows no Host header at all; the server still reaches the hook with `host` undefined. */
const withoutHostHeader = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, LOOPBACK_HOST, () => socket.write(`GET ${path} HTTP/1.0\r\n\r\n`));
    let received = '';
    socket.on('data', (chunk) => (received += String(chunk)));
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
  });

describe('auth disabled — loopback Host', () => {
  it.each(LOOPBACK_HOSTS)('answers /api/status and /ui for Host %s', async (host) => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { host } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/ui', headers: { host } })).statusCode).toBe(200);
  });

  it('answers POST /mcp initialize over a real connection', async () => {
    const res = await wire({
      method: 'POST',
      path: '/mcp',
      headers: { accept: 'application/json, text/event-stream' },
      body: INITIALIZE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"result"');
  });

  it('answers /api/health too — the rule is uniform, with no per-route exceptions', async () => {
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:1' } })).statusCode,
    ).toBe(200);
  });
});

describe('auth disabled — a non-loopback Host is refused on every route', () => {
  it.each(ATTACKER_HOSTS)(
    '403 forbidden_origin for Host %s on GET /api/status, GET /ui/events and POST /mcp',
    async (host) => {
      const status = await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { host } });
      const events = await ctx.app.inject({ method: 'GET', url: '/ui/events', headers: { host } });
      const mcp = await ctx.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { host, accept: 'application/json, text/event-stream' },
        payload: INITIALIZE,
      });
      for (const res of [status, events, mcp]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({
          error: { code: 'forbidden_origin', hint: AUTH_MESSAGES.nonLoopbackRequest },
        });
      }
    },
  );

  it('refuses every method and path alike, including /api/health, /ui and an unknown path', async () => {
    const host = 'attacker.example';
    for (const [method, url] of [
      ['GET', '/api/health'],
      ['GET', '/ui'],
      ['GET', '/ui/assets/app.js'],
      ['POST', '/api/accounts'],
      ['DELETE', '/api/accounts/x'],
      ['GET', '/nonexistent'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, headers: { host } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('never echoes the offending header back', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: 'attacker.example', origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('attacker.example');
    expect(res.body).not.toContain('evil.example');
  });

  it('refuses over a real connection as well (a rebound page speaks real HTTP)', async () => {
    const res = await wire({ method: 'POST', path: '/mcp', headers: { host: 'attacker.example' }, body: INITIALIZE });
    expect(res.status).toBe(403);
    expect(res.body).toContain(AUTH_MESSAGES.nonLoopbackRequest);
  });

  it('refuses a request with no Host header at all', async () => {
    expect(await withoutHostHeader('/api/status')).toContain('403');
  });

  it.each(['a b', 'localhost:99999999', '127.0.0.1@attacker.example'])('refuses a malformed Host %j', async (host) => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: { host } })).statusCode).toBe(403);
  });
});

describe('auth disabled — every registered route is guarded, not a hand-picked list', () => {
  it('answers 403 to a rebound Host on EVERY route Fastify registers, whatever the method', async () => {
    const routes = await registeredRoutes(ctx);

    // Sanity: the capture saw the whole surface (incl. the hijacking SSE route, MCP and HEAD auto-routes).
    const seen = routes.map(({ method, url }) => `${method} ${url}`);
    expect(routes.length).toBeGreaterThan(60);
    expect(seen).toEqual(
      expect.arrayContaining(['GET /ui/events', 'POST /mcp', 'GET /api/status', 'HEAD /api/status', 'GET /api/health']),
    );

    const unguarded: string[] = [];
    for (const route of routes) {
      const res = await ctx.app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.url),
        headers: { host: 'attacker.example' },
      });
      if (res.statusCode !== 403) unguarded.push(`${route.method} ${route.url} → ${res.statusCode}`);
    }
    expect(unguarded).toEqual([]);
  });

  it('also refuses methods no route declares (OPTIONS preflights, TRACE) before Fastify can answer them', async () => {
    for (const method of ['OPTIONS', 'HEAD'] as const) {
      const res = await ctx.app.inject({ method, url: '/api/status', headers: { host: 'attacker.example' } });
      expect(res.statusCode, method).toBe(403);
    }
  });

  it('keeps the live-update stream working for the real dashboard: loopback Host opens /ui/events', async () => {
    const res = await new Promise<{ status: number; type: string }>((resolve, reject) => {
      const req = request(
        { host: LOOPBACK_HOST, port, path: '/ui/events', headers: { origin: `http://${LOOPBACK_HOST}:${port}` } },
        (incoming) => {
          resolve({ status: incoming.statusCode ?? 0, type: String(incoming.headers['content-type']) });
          incoming.destroy(); // a stream never ends on its own
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/event-stream');
  });
});

describe('auth disabled — Origin', () => {
  const get = (origin: string | undefined) =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: '127.0.0.1:51737', ...(origin === undefined ? {} : { origin }) },
    });

  it('allows a request with no Origin (native MCP clients, curl)', async () => {
    expect((await get(undefined)).statusCode).toBe(200);
  });

  it.each(['http://localhost:6274', 'http://127.0.0.1:3001', 'https://localhost', 'http://[::1]:3001'])(
    'allows the loopback Origin %s — MCP Inspector and the dashboard keep working',
    async (origin) => {
      expect((await get(origin)).statusCode).toBe(200);
    },
  );

  it.each(['https://evil.example', 'http://localhost.evil.example', 'null', '', 'ftp://localhost'])(
    'refuses the Origin %j even with a loopback Host',
    async (origin) => {
      const res = await get(origin);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.hint).toBe(AUTH_MESSAGES.nonLoopbackRequest);
    },
  );

  it('refuses a cross-site POST that would otherwise write as the owner', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { host: '127.0.0.1:51737', origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: { name: 'Planted by a web page', type: 'checking', currency: 'USD' },
    });
    expect(res.statusCode).toBe(403);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/accounts', headers: { host: '127.0.0.1:51737' } })).body,
    ).not.toContain('Planted by a web page');
  });
});

describe('the hint', () => {
  it('names loopback and PUBLIC_URL, from the one constant', () => {
    expect(AUTH_MESSAGES.nonLoopbackRequest).toContain('127.0.0.1, localhost or ::1');
    expect(AUTH_MESSAGES.nonLoopbackRequest).toContain('PUBLIC_URL');
  });
});
