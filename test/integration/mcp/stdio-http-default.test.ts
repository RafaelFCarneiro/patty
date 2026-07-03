import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { LOOPBACK_HOST } from '../../../src/common/net.js';
import { McpTransport } from '../../../src/config.js';
import { waitForStderr } from './helpers.js';

const require = createRequire(import.meta.url);
const ENTRY = 'src/main.ts';
const TSX_CLI = require.resolve('tsx/cli');

describe('HTTP sidecar defaults to on under stdio (ADR-013 Decision 7)', () => {
  // Fixed 64-char hex key — never touches the OS keychain
  const TEST_KEY = 'e'.repeat(64);
  let tmpDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = '';

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-sidecar-default-on-test-'));
    const dbPath = join(tmpDir, 'default-on.db');

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, ENTRY],
      stderr: 'pipe',
      env: {
        ...process.env,
        MCP_TRANSPORT: McpTransport.enum.stdio,
        // FINTRACK_HTTP intentionally omitted — this is the point of the test: the sidecar
        // must start without any opt-in env var. PORT=0 lets the OS assign a free port so this
        // test never collides with a real, already-running fintrack instance.
        PORT: '0',
        DB_PATH: dbPath,
        FINTRACK_DB_KEY: TEST_KEY,
      },
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    client = new Client({ name: 'fintrack-sidecar-default-on-vitest', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await transport.close().catch(() => undefined);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts the sidecar without FINTRACK_HTTP set, and stdio MCP stays responsive', async () => {
    const result = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
    expect(result.tools.length).toBeGreaterThan(10);
  });

  it('serves /api and /ui/overview on the port it bound, announced on stderr', async () => {
    await waitForStderr(() => stderr, /HTTP sidecar up/i);
    const boundPort = Number(/:(\d+)\/api/.exec(stderr)?.[1]);
    expect(Number.isInteger(boundPort)).toBe(true);

    const apiRes = await fetch(`http://${LOOPBACK_HOST}:${boundPort}/api/health`);
    expect(apiRes.status).toBe(200);

    const uiRes = await fetch(`http://${LOOPBACK_HOST}:${boundPort}/ui/overview`);
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get('content-type')).toContain('text/html');
  });
});

describe('HTTP sidecar opt-out via FINTRACK_HTTP=false (ADR-013 Decision 7)', () => {
  // Fixed 64-char hex key — never touches the OS keychain
  const TEST_KEY = 'c'.repeat(64);
  let tmpDir: string;
  let client: Client;
  let transport: StdioClientTransport;
  let reservedPort: number;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-sidecar-opt-out-test-'));
    const dbPath = join(tmpDir, 'opt-out.db');

    // Reserve a specific free port, then release it immediately so the spawned process is
    // told to use that exact port — this lets the test prove nothing bound it afterward by
    // successfully binding it itself (see the assertion below).
    const probe: Server = createServer();
    await new Promise<void>((resolve) => probe.listen(0, LOOPBACK_HOST, () => resolve()));
    reservedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, ENTRY],
      env: {
        ...process.env,
        MCP_TRANSPORT: McpTransport.enum.stdio,
        FINTRACK_HTTP: 'false',
        PORT: String(reservedPort),
        DB_PATH: dbPath,
        FINTRACK_DB_KEY: TEST_KEY,
      },
    });

    client = new Client({ name: 'fintrack-sidecar-opt-out-vitest', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await transport.close().catch(() => undefined);
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps stdio MCP responsive with FINTRACK_HTTP=false', async () => {
    const result = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
    expect(result.tools.length).toBeGreaterThan(10);
  });

  it('never binds the sidecar port — this process can still bind it itself', async () => {
    // If the sidecar had started despite FINTRACK_HTTP=false, this port would already be
    // taken and the listen() call below would fail with EADDRINUSE.
    const verifier: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      verifier.once('error', reject);
      verifier.listen(reservedPort, LOOPBACK_HOST, () => resolve());
    });
    await new Promise<void>((resolve) => verifier.close(() => resolve()));
  });
});
