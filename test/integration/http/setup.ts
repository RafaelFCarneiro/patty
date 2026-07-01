import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { buildApp } from '../app-builder.js';

export const setupHttpTest = () => {
  let app: FastifyInstance | undefined;
  let tmpDir: string | undefined;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-http-test-'));
    const ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
    app = ctx.app;
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  const inject = (opts: InjectOptions): Promise<LightMyRequestResponse> => app!.inject(opts);
  return { inject };
};
