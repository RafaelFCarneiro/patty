import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../src/controllers/deps.js';
import { startHttpSidecar, type HttpSidecar } from '../../src/server.js';
import { buildApp } from './app-builder.js';

let tmpDir: string;
let deps: Deps;
let version: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-sidecar-test-'));
  const ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  deps = ctx.deps;
  version = ctx.version;
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('HTTP sidecar (ADR-013 Decision 7)', () => {
  let sidecar: HttpSidecar | undefined;

  afterEach(async () => {
    if (sidecar?.listening) await sidecar.app.close();
    sidecar = undefined;
    vi.restoreAllMocks();
  });

  it('does not throw when the port is already bound, and logs the failure to stderr', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '::', () => resolve()));
    const port = (blocker.address() as AddressInfo).port;

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    sidecar = await startHttpSidecar(deps, version, port);

    expect(sidecar.listening).toBe(false);
    const logged = stderr.mock.calls.flat().join(' ');
    expect(logged).toContain('HTTP sidecar disabled');
    expect(logged).toContain(String(port));

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('comes up and serves /api routes when the port is free', async () => {
    sidecar = await startHttpSidecar(deps, version, 0);
    expect(sidecar.listening).toBe(true);

    const port = (sidecar.app.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('drains cleanly on shutdown — the port is released', async () => {
    sidecar = await startHttpSidecar(deps, version, 0);
    const port = (sidecar.app.server.address() as AddressInfo).port;

    await sidecar.app.close();
    sidecar = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });
});
