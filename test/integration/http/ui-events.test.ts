import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { buildApp } from '../app-builder.js';

// GET /ui/events is a genuinely long-lived stream (reply.hijack(), never app.inject() — see
// diplomat/http/routes/ui.ts) — light-my-request buffers a response until it ends, which this one
// never does, so this suite needs a real listening server + real fetch(), same pattern as
// server.test.ts.
let tmpDir: string;
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-sse-test-'));
  const ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  app = ctx.app;
  await app.listen({ port: 0, host: LOOPBACK_HOST });
  const port = (app.server.address() as AddressInfo).port;
  baseUrl = `http://${LOOPBACK_HOST}:${port}`;
});

afterAll(async () => {
  // Proves forceCloseConnections (composition/http.ts) actually works — without it this would hang on any
  // /ui/events connection this suite left open.
  await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const readUntilMessage = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
};

describe('GET /ui/events (ADR-027 Phase 3 — SSE live update)', () => {
  it('responds with SSE headers and stays open with no immediate body', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');

    controller.abort();
  });

  it('streams the changed entity tag right after a write commits', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    const created = await fetch(`${baseUrl}/api/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `SSE tag ${Date.now()}` }),
    });
    expect(created.status).toBe(201);

    const message = await readUntilMessage(reader);

    expect(message).toBe('data: {"entities":["tag"]}\n\n');

    controller.abort();
  });

  it('a disconnected client stops receiving further messages, other subscribers unaffected', async () => {
    const goneController = new AbortController();
    const goneRes = await fetch(`${baseUrl}/ui/events`, { signal: goneController.signal });
    const goneReader = goneRes.body!.getReader();
    goneController.abort(); // client disconnects before the write below

    const staysController = new AbortController();
    const staysRes = await fetch(`${baseUrl}/ui/events`, { signal: staysController.signal });
    const staysReader = staysRes.body!.getReader();

    await fetch(`${baseUrl}/api/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `SSE tag ${Date.now()}` }),
    });

    const message = await readUntilMessage(staysReader);
    expect(message).toContain('"entities":["tag"]');

    await expect(goneReader.read()).rejects.toThrow();
    staysController.abort();
  });

  it('a publish racing a disconnect (before the close handler runs) never crashes the server', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    // No await between abort() and the write-triggering request — this is the exact race the
    // reply.raw.destroyed guard (diplomat/http/routes/ui.ts) exists for: a publish landing in the
    // gap before the 'close' handler has unsubscribed this connection.
    controller.abort();
    const created = await fetch(`${baseUrl}/api/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `SSE race tag ${Date.now()}` }),
    });
    expect(created.status).toBe(201);

    // The server process (and this Fastify instance) is still alive and serving — an unguarded
    // write-after-destroy that crashed the request handler or the process would fail this.
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);

    await reader.cancel().catch(() => {});
  });

  it('app.close() does not hang on an SSE connection the client never closed (forceCloseConnections)', async () => {
    const isolatedTmpDir = mkdtempSync(join(tmpdir(), 'patty-sse-shutdown-test-'));
    const ctx = await buildApp({ dbPath: join(isolatedTmpDir, 'test.db') });
    await ctx.app.listen({ port: 0, host: LOOPBACK_HOST });
    const port = (ctx.app.server.address() as AddressInfo).port;

    // Deliberately never aborted client-side — this is exactly the connection that would keep
    // server.close() pending forever without forceCloseConnections (Fastify Server.md).
    await fetch(`http://${LOOPBACK_HOST}:${port}/ui/events`);

    const timedOut = Symbol('timed out');
    const result = await Promise.race([
      ctx.app.close().then(() => 'closed' as const),
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 2000)),
    ]);
    expect(result).toBe('closed');

    rmSync(isolatedTmpDir, { recursive: true, force: true });
  });
});
