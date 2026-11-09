import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { waitForStderr } from './helpers.js';
import { keyLockPathForTest } from '../../unit/fixtures/key-lock.js';

/**
 * The real binary over a real pipe, as Claude Desktop runs it: an unsigned `tools/call` returns the link and the code,
 * a person approves at the sidecar the same process bound, and the very next call goes through. The OS keychain is
 * never written: the approval is "this session only", which lives in the process’s memory alone.
 */
const KEY = 'a1'.repeat(32);
const PASSWORD = 'correct horse battery staple';
const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const SPAWN_TIMEOUT_MS = 25_000;

let dir = '';
let dbPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patty-stdio-signin-'));
  dbPath = join(dir, 'patty.db');
  const claimed = spawnSync(
    process.execPath,
    [TSX_CLI, 'src/main.ts', 'auth', 'setup', '--username', 'rafael', '--password-stdin'],
    {
      input: PASSWORD,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, DB_PATH: dbPath, PATTY_DB_KEY: KEY },
    },
  );
  if (claimed.status !== 0) throw new Error(`could not claim the owner: ${claimed.stderr}`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Running = { client: Client; transport: StdioClientTransport; origin: string; stderr: () => string };

const startServer = async (port = '0', sidecar: 'up' | 'blocked' = 'up'): Promise<Running> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, 'src/main.ts'],
    stderr: 'pipe',
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      PATTY_HTTP: 'true',
      PORT: port,
      DB_PATH: dbPath,
      PATTY_DB_KEY: KEY,
      PATTY_AUTH: 'required',
      PATTY_TOKEN: '',
    },
  });
  let captured = '';
  transport.stderr?.on('data', (chunk: Buffer) => void (captured += chunk.toString()));
  const client = new Client({ name: 'patty-stdio-signin-vitest', version: '4.5.6' });
  await client.connect(transport);
  await waitForStderr(() => captured, sidecar === 'up' ? /HTTP sidecar up/i : /HTTP sidecar disabled/i);
  const origin = sidecar === 'up' ? /(http:\/\/127\.0\.0\.1:\d+)\/api/.exec(captured)?.[1] : 'none';
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
    body: form({ code, decision: 'approve', access, duration: 'session', password: PASSWORD }),
  });

const database = async () => {
  const db = await openDatabase({ KEY_LOCK_PATH: keyLockPathForTest(), DB_PATH: dbPath, PATTY_DB_KEY: KEY });
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
        `PATTY: not signed in. Open ${origin}/ui/connect?code=${code} and confirm the code ${code}.`,
      );

      const cookie = await logIn(origin);
      const consent = await fetch(`${origin}/ui/connect?code=${code}`, { headers: { cookie } });
      expect(consent.status).toBe(200);
      const page = await consent.text();
      expect(page).toContain('patty-stdio-signin-vitest');
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
        [{ kind: 'stdio', client_name: 'patty-stdio-signin-vitest', revoked: 1 }],
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
      expect(stderr()).not.toMatch(/ptk_[A-Za-z0-9_-]{20,}/);
      expect(stderr()).not.toContain(PASSWORD);
    } finally {
      await transport.close();
    }
  });
});

describe('a stdio process whose sidecar cannot bind (the binary)', () => {
  it('serves /ui/connect itself, on its own database — never pointing at whatever holds the port', async () => {
    // Something else owns the configured port (another PATTY on a different database would look just like this).
    const squatter = createServer((_req, res) => res.end('not this database'));
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const taken = (squatter.address() as AddressInfo).port;
    const { client, transport, stderr } = await startServer(String(taken), 'blocked');
    try {
      const asked = textOf(await client.callTool({ name: 'list_accounts', arguments: {} }));
      const [, origin, code] = /(http:\/\/localhost:(?:\d+))\/ui\/connect\?code=([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(asked)!;
      expect(origin).not.toContain(`:${taken}`);
      expect(asked).toBe(
        `PATTY: not signed in. Open ${origin}/ui/connect?code=${code} and confirm the code ${code}.`,
      );

      const cookie = await logIn(origin!);
      expect((await approve(origin!, cookie, code!, 'write')).status).toBe(200);

      const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(accounts.isError).toBeFalsy();
      // Redeemed, so its temporary page has been closed again.
      await expect(fetch(`${origin}/api/health`)).rejects.toThrow();
      expect(stderr()).not.toMatch(/ptk_[A-Za-z0-9_-]{20,}/);
    } finally {
      await transport.close();
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});
