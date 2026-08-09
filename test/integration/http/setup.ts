import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import type { Deps, RunEffects } from '../../../src/controllers/deps.js';
import { buildApp, type AppContext } from '../app-builder.js';

export const setupHttpTest = () => {
  let ctx: AppContext | undefined;
  let tmpDir: string | undefined;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-http-test-'));
    ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
    await ctx.app.ready();
  });

  afterAll(async () => {
    await ctx?.app.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  const inject = (opts: InjectOptions): Promise<LightMyRequestResponse> => ctx!.app.inject(opts);
  // Only needed by domains with no REST write route to seed fixtures through (e.g. budgets,
  // whose create/update/delete tools stay MCP-only) — every other test seeds via `inject` alone.
  const getDeps = (): Deps => ctx!.deps;
  const getRunEffects = (): RunEffects => ctx!.runEffects;
  return { inject, getDeps, getRunEffects };
};
