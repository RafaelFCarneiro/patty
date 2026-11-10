import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IPV4_WILDCARD_HOST, LOOPBACK_HOST } from '../../src/common/net.js';
import type { Runtime } from '../../src/composition/runtime.js';
import { startHttpSidecar, type HttpSidecar } from '../../src/composition/http.js';
import { buildApp } from './app-builder.js';

let tmpDir: string;
let runtime: Runtime;
let version: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-sidecar-test-'));
  const ctx = await buildApp({ dbPath: join(tmpDir, 'test.db') });
  runtime = ctx.runtime;
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
    await new Promise<void>((resolve) => blocker.listen(0, LOOPBACK_HOST, () => resolve()));
    const port = (blocker.address() as AddressInfo).port;

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    sidecar = await startHttpSidecar(runtime, version, port);

    expect(sidecar.listening).toBe(false);
    const logged = stderr.mock.calls.flat().join(' ');
    expect(logged).toContain('HTTP sidecar disabled');
    expect(logged).toContain(String(port));

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('comes up and serves /api routes when the port is free', async () => {
    sidecar = await startHttpSidecar(runtime, version, 0);
    expect(sidecar.listening).toBe(true);

    const port = (sidecar.app.server.address() as AddressInfo).port;
    const res = await fetch(`http://${LOOPBACK_HOST}:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('binds loopback-only, not the LAN-reachable wildcard address', async () => {
    sidecar = await startHttpSidecar(runtime, version, 0);
    expect(sidecar.listening).toBe(true);

    const address = sidecar.app.server.address() as AddressInfo;
    expect(address.address).toBe(LOOPBACK_HOST);
  });

  it('binds the configured host and prints a reachable loopback URL for a wildcard bind (ADR-032)', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wildcardHost = IPV4_WILDCARD_HOST;

    sidecar = await startHttpSidecar(runtime, version, 0, wildcardHost);

    expect(sidecar.listening).toBe(true);
    const address = sidecar.app.server.address() as AddressInfo;
    expect(address.address).toBe(wildcardHost);
    const logged = stderr.mock.calls.flat().join(' ');
    expect(logged).toContain(`http://${LOOPBACK_HOST}:${address.port}/api`);
    expect(logged).not.toContain(wildcardHost);
  });

  it('drains cleanly on shutdown — the port is released', async () => {
    sidecar = await startHttpSidecar(runtime, version, 0);
    expect(sidecar.listening).toBe(true);
    const port = (sidecar.app.server.address() as AddressInfo).port;

    await sidecar.app.close();
    sidecar = undefined;

    await expect(fetch(`http://${LOOPBACK_HOST}:${port}/api/health`)).rejects.toThrow();
  });
});
