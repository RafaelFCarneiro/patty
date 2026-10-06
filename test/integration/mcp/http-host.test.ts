import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { McpTransport } from '../../../src/config.js';
import { waitForStderr } from './helpers.js';

const require = createRequire(import.meta.url);
const ENTRY = 'src/main.ts';
const TSX_CLI = require.resolve('tsx/cli');
const WILDCARD_HOST = '0.0.0.0';

const findLanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((iface) => iface?.family === 'IPv4' && !iface.internal)?.address;

describe('pure http mode binds the configured HOST (ADR-032)', () => {
  let tmpDir: string;
  let child: ChildProcess;
  let stdout = '';
  let stderr = '';

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-http-host-test-'));
    // Key via FINTRACK_DB_KEY_FILE, so the file path is exercised end-to-end and the keychain is never touched.
    const keyFile = join(tmpDir, 'db-key');
    writeFileSync(keyFile, `${'d'.repeat(64)}\n`);

    child = spawn(process.execPath, [TSX_CLI, ENTRY], {
      env: {
        ...process.env,
        MCP_TRANSPORT: McpTransport.enum.http,
        HOST: WILDCARD_HOST,
        // PORT=0 lets the OS assign a free port so this never collides with a running instance.
        PORT: '0',
        DB_PATH: join(tmpDir, 'http-host.db'),
        FINTRACK_DB_KEY_FILE: keyFile,
      },
    });
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await waitForStderr(() => stdout + stderr, /fintrack: REST /);
  });

  afterAll(async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints a reachable loopback URL, not the wildcard, in the startup banner', () => {
    const port = /REST http:\/\/127\.0\.0\.1:(\d+)\/api/.exec(stdout)?.[1];
    expect(Number(port)).toBeGreaterThan(0);
    expect(stdout).not.toContain(WILDCARD_HOST);
  });

  it('serves on loopback and, because it bound the wildcard, on the LAN address too', async () => {
    const port = Number(/:(\d+)\/api/.exec(stdout)?.[1]);
    expect((await fetch(`http://${LOOPBACK_HOST}:${port}/api/health`)).status).toBe(200);

    const lanAddress = findLanAddress();
    if (lanAddress) expect((await fetch(`http://${lanAddress}:${port}/api/health`)).status).toBe(200);
  });
});
