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

// Fixed 64-char hex key — never touches the OS keychain
const TEST_KEY = 'f'.repeat(64);
const require = createRequire(import.meta.url);
const ENTRY = 'src/main.ts';
const TSX_CLI = require.resolve('tsx/cli');

let tmpDir: string;
let blocker: Server;
let blockedPort: number;
let client: Client;
let transport: StdioClientTransport;
let stderr = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'patty-sidecar-stdio-test-'));
  const dbPath = join(tmpDir, 'sidecar.db');

  // Occupy the sidecar's target port before the server ever starts, so its bind attempt fails.
  blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, LOOPBACK_HOST, () => resolve()));
  blockedPort = (blocker.address() as AddressInfo).port;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, ENTRY],
    stderr: 'pipe',
    env: {
      ...process.env,
      MCP_TRANSPORT: McpTransport.enum.stdio,
      PATTY_HTTP: 'true',
      PORT: String(blockedPort),
      DB_PATH: dbPath,
      PATTY_DB_KEY: TEST_KEY,
    },
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  client = new Client({ name: 'patty-sidecar-stdio-vitest', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await transport.close().catch(() => undefined);
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('HTTP sidecar bind failure alongside stdio MCP (ADR-013 Decision 7)', () => {
  it('keeps the stdio MCP connection responsive when the sidecar port is already taken', async () => {
    const result = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
    expect(result.tools.length).toBeGreaterThan(10);
  });

  it('surfaces the bind failure on stderr — never on stdout, which carries the MCP protocol', async () => {
    await waitForStderr(() => stderr, /HTTP sidecar disabled/i);
    expect(stderr).toContain(String(blockedPort));
  });
});
