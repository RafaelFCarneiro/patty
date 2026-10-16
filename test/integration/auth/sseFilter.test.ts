import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { ACCOUNT_ENTITY_TAG } from '../../../src/models/account.js';
import { SESSION_ENTITY_TAG, SETUP_CODE_ENTITY_TAG, USER_ENTITY_TAG } from '../../../src/models/auth/entity.js';
import { OWNER_USER_ID } from '../../../src/models/auth/owner.js';
import { CURRENCY_RATE_ENTITY_TAG } from '../../../src/models/currencyRate.js';
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

describe('GET /ui/events and whose changes it forwards', () => {
  it('forwards only its own user’s changes, never instance bookkeeping (session/user/setup-code)', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    ctx.changeBus.publish({ userId: null, entities: [SESSION_ENTITY_TAG, USER_ENTITY_TAG, SETUP_CODE_ENTITY_TAG] });
    ctx.changeBus.publish({ userId: 'someone-else', entities: [ACCOUNT_ENTITY_TAG] });
    ctx.changeBus.publish({ userId: OWNER_USER_ID, entities: [ACCOUNT_ENTITY_TAG] });

    // The first message on the wire is the owner's: the two before it were dropped.
    const message = await nextMessage(reader);
    expect(message).toContain(`"entities":["${ACCOUNT_ENTITY_TAG}"]`);
    expect(message).not.toContain(SESSION_ENTITY_TAG);
    controller.abort();
  });
});

describe('GET /ui/events and shared entities', () => {
  it('forwards another user’s change only for shared tags, so a rate update refreshes everyone', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    // A mixed event from another user: the private tag is dropped, the shared one kept.
    ctx.changeBus.publish({ userId: 'someone-else', entities: [ACCOUNT_ENTITY_TAG, CURRENCY_RATE_ENTITY_TAG] });

    const message = await nextMessage(reader);
    expect(message).toContain(`"entities":["${CURRENCY_RATE_ENTITY_TAG}"]`);
    expect(message).not.toContain(ACCOUNT_ENTITY_TAG);
    controller.abort();
  });

  it('forwards the user’s own mixed event whole', async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/ui/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    ctx.changeBus.publish({ userId: OWNER_USER_ID, entities: [ACCOUNT_ENTITY_TAG, CURRENCY_RATE_ENTITY_TAG] });

    expect(await nextMessage(reader)).toContain(`"entities":["${ACCOUNT_ENTITY_TAG}","${CURRENCY_RATE_ENTITY_TAG}"]`);
    controller.abort();
  });
});
