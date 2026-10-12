import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { waitForStderr } from './helpers.js';

/**
 * The real binary over a real pipe, as Claude Desktop runs it: an unsigned `tools/call` returns the link and the code,
 * a person approves at the sidecar the same process bound, and the very next call goes through. The OS keychain is
 * never written: the approval is "this Claude session only", which lives in the process’s memory alone.
 */
const KEY = 'a1'.repeat(32);
const PASSWORD = 'correct horse battery staple';
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const SPAWN_TIMEOUT_MS = 25_000;

let dir = '';
let dbPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-stdio-signin-'));
  dbPath = join(dir, 'fintrack.db');
  const claimed = spawnSync(
    process.execPath,
    [TSX_CLI, 'src/main.ts', 'auth', 'setup', '--username', 'rafael', '--password-stdin'],
    {
      input: PASSWORD,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, DB_PATH: dbPath, FINTRACK_DB_KEY: KEY },
    },
  );
  if (claimed.status !== 0) throw new Error(`could not claim the owner: ${claimed.stderr}`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Running = { client: Client; transport: StdioClientTransport; origin: string; stderr: () => string };

const startServer = async (): Promise<Running> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, 'src/main.ts'],
    stderr: 'pipe',
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      FINTRACK_HTTP: 'true',
      PORT: '0',
      DB_PATH: dbPath,
      FINTRACK_DB_KEY: KEY,
      FINTRACK_AUTH: 'required',
      FINTRACK_TOKEN: '',
    },
  });
  let captured = '';
  transport.stderr?.on('data', (chunk: Buffer) => void (captured += chunk.toString()));
  const client = new Client({ name: 'fintrack-stdio-signin-vitest', version: '4.5.6' });
  await client.connect(transport);
  await waitForStderr(() => captured, /HTTP sidecar up/i);
  const origin = /(http:\/\/127\.0\.0\.1:\d+)\/api/.exec(captured)?.[1];
  if (!origin) throw new Error(`no sidecar origin in: ${captured}`);
  return { client, transport, origin, stderr: () => captured };
};

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** Log in at the sidecar and return the session cookie, as a browser would. */
const logIn = async (origin: string): Promise<string> => {
  const res = await fetch(`${origin}/ui/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: form({ username: 'rafael', password: PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (res.status !== 303 || !cookie) throw new Error(`login failed: ${res.status}`);
  return cookie;
};

const approve = (origin: string, cookie: string, code: string, access: 'read' | 'write') =>
  fetch(`${origin}/ui/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie },
    body: form({ code, decision: 'approve', access, duration: 'session' }),
  });

const database = async () => {
  const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: KEY });
  return { db, close: () => closeDatabase(db) };
};

describe('stdio sign-in end to end (the binary)', () => {
  it('asks with a link, proceeds after approval, and ends the "this session only" sign-in on exit', async () => {
    const { client, transport, origin } = await startServer();
    try {
      const asked = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(asked.isError).toBe(true);
      const code = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(textOf(asked))?.[1];
      expect(textOf(asked)).toBe(
        `FinTrack: not signed in. Open ${origin}/ui/connect?code=${code} and confirm the code ${code}.`,
      );

      const cookie = await logIn(origin);
      const consent = await fetch(`${origin}/ui/connect?code=${code}`, { headers: { cookie } });
      expect(consent.status).toBe(200);
      const page = await consent.text();
      expect(page).toContain('fintrack-stdio-signin-vitest');
      expect(page).toContain('4.5.6');
      expect((await approve(origin, cookie, code!, 'write')).status).toBe(200);

      const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(accounts.isError).toBeFalsy();
      expect((await client.callTool({ name: 'create_tag', arguments: { name: 'e2e' } })).isError).toBeFalsy();
    } finally {
      await transport.close();
    }

    // The process has exited: its shutdown revoked the in-memory sign-in, so a restart has to ask again.
    const { db, close } = await database();
    try {
      expect(await db.all(sql`SELECT kind, client_name, revoked_at IS NOT NULL AS revoked FROM access_tokens`)).toEqual(
        [{ kind: 'stdio', client_name: 'fintrack-stdio-signin-vitest', revoked: 1 }],
      );
      expect(await db.all(sql`SELECT status FROM client_grants`)).toEqual([{ status: 'redeemed' }]);
    } finally {
      close();
    }
    const again = await startServer();
    try {
      const result = await again.client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('not signed in');
    } finally {
      await again.transport.close();
    }
  });

  it('refuses a write to a read-only approval, and never puts a secret in the output of either side', async () => {
    const { client, transport, origin, stderr } = await startServer();
    try {
      const code = /code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(
        textOf(await client.callTool({ name: 'get_status', arguments: {} })),
      )![1]!;
      const cookie = await logIn(origin);
      await approve(origin, cookie, code, 'read');

      expect((await client.callTool({ name: 'list_tags', arguments: {} })).isError).toBeFalsy();
      const refused = await client.callTool({ name: 'create_tag', arguments: { name: 'nope' } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('insufficient_scope');
      expect(stderr()).not.toMatch(/ftk_[A-Za-z0-9_-]{20,}/);
      expect(stderr()).not.toContain(PASSWORD);
    } finally {
      await transport.close();
    }
  });
});
