import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_MESSAGES } from '../../../src/diplomat/cli/messages.js';
import { verifyPassword } from '../../../src/diplomat/auth/credentials.js';
import { closeDatabase, openDatabase } from '../../../src/diplomat/db/driver.js';
import { PROMPT_MESSAGES } from '../../../src/diplomat/cli/prompt.js';
import { STDIO_ENTRY } from '../../../src/diplomat/client-config/merge.js';
import { bootstrap } from '../../../src/diplomat/db/bootstrap.js';
import { MIGRATIONS_TABLE } from '../../../src/diplomat/db/migration-barrier.js';
import { LOGIN_MESSAGES } from '../../../src/diplomat/cli/commands/login.js';
import { USAGE } from '../../../src/diplomat/cli/commands.js';
import { databaseAheadMessage } from '../../../src/models/database.js';
import { DEMO_DB_KEY, DEMO_ENV_ON, DEMO_ENV_VAR, demoNotReady } from '../../../src/models/demo/core.js';
import { startupRefusalMessage } from '../../../src/models/startup.js';

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

describe('fintrack setup <client> — the sign-in step (the binary)', () => {
  it('without a terminal skips the offer with a one-line hint naming the pinned login command (exit 0)', () => {
    const result = fintrack(['setup', 'claude-code', '--username', 'rafael', '--password-stdin'], PASSWORD);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain(LOGIN_MESSAGES.skippedNoTerminal('default'));
    expect(result.stdout).toContain('npx @rafaelfcarneiro/fintrack@latest login --profile default');
  });

  it('with --profile writes FINTRACK_PROFILE into the client entry and names that profile in the hint', () => {
    const result = fintrack(
      ['setup', 'claude-code', '--username', 'rafael', '--password-stdin', '--profile', 'work'],
      PASSWORD,
    );
    expect(result.exit).toBe(0);
    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8'))).toEqual({
      mcpServers: { fintrack: { ...STDIO_ENTRY, env: { FINTRACK_PROFILE: 'work' } } },
    });
    expect(result.stdout).toContain(LOGIN_MESSAGES.skippedNoTerminal('work'));
  });
});

describe('unknown commands never start a server (the binary)', () => {
  it.each([
    ['bogus'],
    ['auth', 'bogus'],
    ['--bogus'],
    ['setup', 'claude-code', '--bogus'],
    ['login', 'stray'],
    ['logout', '--duration', '24h'],
  ])('fintrack %s exits non-zero with usage', (...args) => {
    const result = fintrack(args);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/fintrack: |Usage:/);
  });

  it('prints the usage for an unknown command, naming the pinned command', () => {
    const result = fintrack(['bogus']);
    expect(result.stderr).toContain('unknown command "bogus"');
    expect(result.stderr).toContain(USAGE.trim());
    expect(result.stderr).toContain('npx @rafaelfcarneiro/fintrack@latest');
  });

  it('prints the usage and exits 0 for help', () => {
    for (const flag of ['--help', '-h', 'help']) {
      const result = fintrack([flag]);
      expect(result.exit, flag).toBe(0);
      expect(result.stdout).toContain('Usage:');
    }
  });

  it('does not open the database for any of them', () => {
    fintrack(['bogus']);
    fintrack(['auth', 'bogus']);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe('an older build against a newer database (the binary)', () => {
  const AHEAD = databaseAheadMessage('0.0.0-development');

  const aheadDatabase = async () => {
    const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: KEY });
    try {
      await bootstrap(db);
      await db.run(
        sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} (hash, created_at) VALUES ('from-the-future', ${Date.now() + 10 * 365 * 24 * 3600 * 1000})`,
      );
      await db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
    } finally {
      closeDatabase(db);
    }
  };

  const fingerprint = () => ({
    size: statSync(dbPath).size,
    mtimeMs: statSync(dbPath).mtimeMs,
    sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
  });

  it.each([
    [['auth', 'setup', '--username', 'rafael', '--password-stdin'], PASSWORD],
    [['auth', 'reset-password', '--password-stdin'], NEW_PASSWORD],
    [['setup', 'claude-code', '--username', 'rafael', '--password-stdin'], PASSWORD],
    [['login'], ''],
    [['logout'], ''],
  ] as const)('fintrack %s exits non-zero with the version-guard message and changes nothing', async (args, stdin) => {
    await aheadDatabase();
    const before = fingerprint();

    const result = fintrack([...args], stdin);

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(AHEAD);
    expect(result.stderr).not.toContain('    at '); // a diagnosis, not a stack trace
    expect(fingerprint()).toEqual(before);
    expect(existsSync(claudeCodeConfig())).toBe(false);
  });

  it('refuses to start as a server too (stdio), with the same message and nothing written', async () => {
    await aheadDatabase();
    const before = fingerprint();

    const result = fintrack([]);

    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(AHEAD);
    expect(fingerprint()).toEqual(before);
  });
});

describe('a process told to open the demo against a database that is not one (the binary)', () => {
  const startDemoServer = (transport: 'stdio' | 'http') => {
    const { FINTRACK_DB_KEY: _key, ...env } = process.env;
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...env, DB_PATH: dbPath, HOME: home, MCP_TRANSPORT: transport, [DEMO_ENV_VAR]: DEMO_ENV_ON },
    });
  };

  it.each(['stdio', 'http'] as const)('%s: prints the refusal, no stack, and exits non-zero', async (transport) => {
    const db = await openDatabase({ DB_PATH: dbPath, FINTRACK_DB_KEY: DEMO_DB_KEY });
    try {
      await bootstrap(db);
    } finally {
      closeDatabase(db);
    }

    const result = startDemoServer(transport);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(startupRefusalMessage(demoNotReady(dbPath)));
    expect(result.stderr).not.toContain('    at ');
  });
});
