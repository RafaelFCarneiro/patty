import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../app-builder.js';

let tmpDir: string;
let ctx: AppContext;
const reported: unknown[] = [];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-bus-isolation-test-'));
  ctx = await buildApp({ dbPath: join(tmpDir, 'test.db'), onChangeError: (cause) => reported.push(cause) });
  await ctx.app.ready();
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('change bus subscriber failure isolation', () => {
  it('a throwing subscriber does not fail the committed write and reaches the bus onError', async () => {
    const boom = new Error('subscriber boom');
    ctx.changeBus.subscribe(() => {
      throw boom;
    });

    const name = `Isolation tag ${Date.now()}`;
    const created = await ctx.app.inject({ method: 'POST', url: '/api/tags', payload: { name } });
    expect(created.statusCode).toBe(201);

    expect(reported).toContain(boom);

    const listed = await ctx.app.inject({ method: 'GET', url: '/api/tags' });
    expect(listed.body).toContain(name);
  });
});
