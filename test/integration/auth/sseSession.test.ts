import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerUiRoutes } from '../../../src/diplomat/http/routes/ui.js';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { claimOwner } from './helpers.js';
import { OWNER_PRINCIPAL } from '../../../src/models/auth/principal.js';
import '../../../src/diplomat/http/principal.js';

const RECHECK_MS = 40;

let tmpDir: string;
let ctx: AppContext;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-sse-session-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db'), auth: {}, sessionRecheckMs: RECHECK_MS });
  await ctx.app.listen({ port: 0, host: LOOPBACK_HOST });
  baseUrl = `http://${LOOPBACK_HOST}:${(ctx.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /ui/events with sessions required', () => {
  it('refuses a stream without a session', async () => {
    const res = await fetch(`${baseUrl}/ui/events`, { redirect: 'manual' });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
  });

  it('ends an open stream once its session is gone', async () => {
    const cookie = await claimOwner(ctx);
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { headers: { cookie }, signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();

    await ctx.db.run(sql`DELETE FROM sessions`); // logout, expiry and a disabled user all end like this

    // The server closes the stream on its next re-check; a still-open stream would never resolve `done`.
    const outcome = await Promise.race([
      reader.read().then(({ done }) => (done ? 'closed' : 'data')),
      new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 3000)),
    ]);
    controller.abort();
    expect(outcome).toBe('closed');
  });
});

describe('GET /ui/events when the session check itself fails', () => {
  it('fails closed: the stream ends and nothing is left unhandled', async () => {
    const app = Fastify();
    // What the auth hook does in a real app: the stream belongs to a user.
    app.addHook('onRequest', async (req) => {
      req.principal = OWNER_PRINCIPAL;
    });
    registerUiRoutes(app, () => () => {}, {
      authControls: false,
      session: {
        isActive: async () => {
          throw new Error('database unavailable');
        },
        everyMs: RECHECK_MS,
      },
    });
    await app.listen({ port: 0, host: LOOPBACK_HOST });
    const port = (app.server.address() as AddressInfo).port;
    const controller = new AbortController();
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    const outcome = await Promise.race([
      reader.read().then(({ done }) => (done ? 'closed' : 'data')),
      new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 3000)),
    ]);
    controller.abort();
    await app.close();
    expect(outcome).toBe('closed');
  });
});

describe('GET /ui/events without a principal', () => {
  it('opens no stream at all — a handler that reaches for a user without one fails closed, to nobody', async () => {
    const app = Fastify();
    const subscribed = vi.fn(() => () => {});
    registerUiRoutes(app, subscribed, { authControls: false });
    const res = await app.inject({ method: 'GET', url: '/ui/events' });
    await app.close();

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).not.toContain('text/event-stream');
    expect(subscribed).not.toHaveBeenCalled();
  });
});
