import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { buildApp, type AppContext } from '../app-builder.js';
import { claimOwner } from './helpers.js';

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
