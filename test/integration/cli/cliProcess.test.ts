import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../../../src/authCli.js';
import { verifyPassword } from '../../../src/diplomat/auth/credentials.js';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { PROMPT_MESSAGES } from '../../../src/diplomat/cli/prompt.js';
import { STDIO_ENTRY } from '../../../src/setup.js';

/**
 * The real binary, as a script or an installer runs it: a child process with a piped (non-TTY) stdin, its own
 * database file and key, and a throwaway HOME for the client config. Slow (a cold start each), so these cover the
 * wiring end to end; the decisions are covered in-process in `test/integration/auth/cli.test.ts`.
 */
const KEY = 'e'.repeat(64);
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new passphrase';
const SPAWN_TIMEOUT_MS = 25_000;

let dir = '';
let dbPath = '';
let home = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fintrack-cli-'));
  dbPath = join(dir, 'fintrack.db');
  home = join(dir, 'home');
  mkdirSync(home);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fintrack = (args: string[], stdin = '') => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, DB_PATH: dbPath, FINTRACK_DB_KEY: KEY, HOME: home },
  });
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
};

const owner = async () => {
  const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: KEY });
  try {
    const rows = await db.all<{ id: string; username: string | null; password_hash: string | null }>(
      sql`SELECT id, username, password_hash FROM users`,
    );
    const sessionCount = await db.all(sql`SELECT 1 FROM sessions`);
    return { rows, sessionCount: sessionCount.length };
  } finally {
    closeDatabase(db);
  }
};

const claudeCodeConfig = () => join(home, '.claude', 'mcp.json');

describe('fintrack auth setup (the binary)', () => {
  it('claims with --password-stdin, then says it is already claimed on a re-run (exit 0 both times)', async () => {
    const first = fintrack(['auth', 'setup', '--username', 'Rafael', '--password-stdin'], `${PASSWORD}\n`);
    expect(first.exit).toBe(0);
    expect(first.stdout).toContain(CLI_MESSAGES.ownerClaimed('rafael'));

    const { rows, sessionCount } = await owner();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('rafael');
    expect(await verifyPassword(rows[0]?.password_hash ?? '', PASSWORD)).toBe(true);
    expect(sessionCount).toBe(0);

    const again = fintrack(['auth', 'setup']);
    expect(again.exit).toBe(0);
    expect(again.stdout).toContain(CLI_MESSAGES.alreadyClaimed('rafael'));
  });

  it('with no TTY and no --password-stdin exits non-zero with instructions and writes nothing', async () => {
    const result = fintrack(['auth', 'setup']);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(PROMPT_MESSAGES.noTerminal);
    expect((await owner()).rows[0]).toMatchObject({ username: null, password_hash: null });
  });

  it('never prints the password', () => {
    const result = fintrack(['auth', 'setup', '--username', 'rafael', '--password-stdin'], PASSWORD);
    expect(result.stdout + result.stderr).not.toContain(PASSWORD);
  });
});

describe('fintrack setup <client> (the binary)', () => {
  it('on a fresh database claims the owner, then writes the client config', async () => {
    const result = fintrack(['setup', 'claude-code', '--username', 'rafael', '--password-stdin'], PASSWORD);

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain(CLI_MESSAGES.ownerClaimed('rafael'));
    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8'))).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } });
    expect((await owner()).rows[0]?.username).toBe('rafael');
  });

  it('with no TTY and no --password-stdin exits non-zero BEFORE writing any config', async () => {
    const result = fintrack(['setup', 'claude-code']);

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(PROMPT_MESSAGES.noTerminal);
    expect(existsSync(claudeCodeConfig())).toBe(false);
    expect((await owner()).rows[0]).toMatchObject({ username: null, password_hash: null });
  });

  it('is safe to re-run: skips the claim and still merges the config idempotently', async () => {
    fintrack(['auth', 'setup', '--username', 'rafael', '--password-stdin'], PASSWORD);
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeCodeConfig(), JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));

    const first = fintrack(['setup', 'claude-code']);
    const written = readFileSync(claudeCodeConfig(), 'utf8');
    const second = fintrack(['setup', 'claude-code']);

    expect([first.exit, second.exit]).toEqual([0, 0]);
    expect(first.stdout).toContain(CLI_MESSAGES.alreadyClaimed('rafael'));
    expect(readFileSync(claudeCodeConfig(), 'utf8')).toBe(written);
    expect(JSON.parse(written)).toEqual({
      mcpServers: { other: { command: 'x' }, fintrack: STDIO_ENTRY },
      theme: 'dark',
    });
  });

  it('never claims for the help or an unknown client', async () => {
    expect(fintrack(['setup']).exit).toBe(0);
    const unknown = fintrack(['setup', 'no-such-client']);
    expect(unknown.exit).toBe(1);
    expect(unknown.stderr).toContain('unknown tool');
  });
});

describe('fintrack auth reset-password (the binary)', () => {
  it('replaces the hash so only the new password verifies, and reports the counts', async () => {
    fintrack(['auth', 'setup', '--username', 'rafael', '--password-stdin'], PASSWORD);

    const result = fintrack(['auth', 'reset-password', '--password-stdin'], NEW_PASSWORD);

    expect(result.exit).toBe(0);
    expect(result.stdout).toContain(CLI_MESSAGES.sessionsEnded(0));
    expect(result.stdout).toContain(CLI_MESSAGES.tokensRevoked(0));
    const hash = (await owner()).rows[0]?.password_hash ?? '';
    expect(await verifyPassword(hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, PASSWORD)).toBe(false);
  });

  it('fails clearly for an unknown user', () => {
    fintrack(['auth', 'setup', '--username', 'rafael', '--password-stdin'], PASSWORD);
    const result = fintrack(['auth', 'reset-password', '--user', 'ghost', '--password-stdin'], NEW_PASSWORD);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain('ghost');
  });
});
