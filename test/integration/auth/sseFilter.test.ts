import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { ACCOUNT_ENTITY_TAG } from '../../../src/models/account.js';
import { SESSION_ENTITY_TAG, SETUP_CODE_ENTITY_TAG, USER_ENTITY_TAG } from '../../../src/models/auth/entity.js';
import { buildApp, type AppContext } from '../app-builder.js';

let tmpDir: string;
let ctx: AppContext;
let baseUrl: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-sse-auth-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  await ctx.app.listen({ port: 0, host: LOOPBACK_HOST });
  baseUrl = `http://${LOOPBACK_HOST}:${(ctx.app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const nextMessage = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
};

describe('GET /ui/events and auth bookkeeping', () => {
  it('never forwards session/user/setup-code tags, and sends nothing when only those changed', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    ctx.changeBus.publish([SESSION_ENTITY_TAG, USER_ENTITY_TAG, SETUP_CODE_ENTITY_TAG]);
    ctx.changeBus.publish([SESSION_ENTITY_TAG, ACCOUNT_ENTITY_TAG]);

    // The first message on the wire is the second publish, stripped of the auth tag — the first was dropped.
    const message = await nextMessage(reader);
    expect(message).toContain(`"entities":["${ACCOUNT_ENTITY_TAG}"]`);
    expect(message).not.toContain(SESSION_ENTITY_TAG);
    controller.abort();
  });
});
