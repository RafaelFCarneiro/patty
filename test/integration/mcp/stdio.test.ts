import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpTransport } from '../../../src/config.js';
import { callTool } from './helpers.js';

// Fixed 64-char hex key — never touches the OS keychain
const TEST_KEY = 'd'.repeat(64);
const require = createRequire(import.meta.url);
const ENTRY = 'src/main.ts';
const TSX_CLI = require.resolve('tsx/cli');

let tmpDir: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-stdio-test-'));
  const dbPath = join(tmpDir, 'stdio.db');

  transport = new StdioClientTransport({
    // Use the local tsx CLI directly so the test does not depend on PATH injection.
    command: process.execPath,
    args: [TSX_CLI, ENTRY],
    env: {
      ...process.env,
      MCP_TRANSPORT: McpTransport.enum.stdio,
      DB_PATH: dbPath,
      FINTRACK_DB_KEY: TEST_KEY,
    },
  });

  client = new Client({ name: 'fintrack-stdio-vitest', version: '1.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  await transport.close().catch(() => undefined);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('MCP stdio transport', () => {
  it('initializes and lists tools', async () => {
    const result = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('list_categories');
    expect(names).toContain('create_transaction');
    expect(names.length).toBeGreaterThan(10);
  });

  it('calls list_categories and returns seeded categories', async () => {
    const categories = (await callTool(client, { name: 'list_categories' })) as Array<{ name: string }>;
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);
    const names = categories.map((c) => c.name);
    expect(names).toContain('Food');
    expect(names).toContain('Transport');
  });
});
