import { sql } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_HELP, parseClaimArgs, runAuthCommand } from '../../../src/diplomat/cli/commands/auth.js';
import { type CliIo, EXIT_FAILURE, EXIT_OK } from '../../../src/diplomat/cli/io.js';
import { CLI_MESSAGES } from '../../../src/diplomat/cli/messages.js';
import { AUTH_POSITIONALS, SETUP_POSITIONALS } from '../../../src/wire/in/cli.js';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { createSignInInterpreter } from '../../../src/composition/sign-in/interpreter.js';
import { PROMPT_MESSAGES } from '../../../src/diplomat/cli/prompt.js';
import { accessTokens, sessions, users } from '../../../src/diplomat/db/schema.js';
import { OWNER_USER_ID, UserRole } from '../../../src/models/auth/owner.js';
import { DEFAULT_PROFILE } from '../../../src/models/auth/sign-in.js';
import type { AppContext } from '../app-builder.js';
import {
  authDepsOf,
  bearer,
  claimOwner,
  FORM_HEADERS,
  formBody,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  memoryStore,
  mintToken,
  PASSWORD,
  sessionCookieOf,
  useAuthApp,
  USERNAME,
} from './helpers.js';

const createApp = useAuthApp();

const NEW_PASSWORD = 'a brand new passphrase';

type Harness = { io: CliIo; out: string[]; err: string[]; run: (...args: string[]) => Promise<number> };

/** The CLI against the test app's own database — what `main.ts` wires with `openShell`, minus the process. */
const harness = (ctx: AppContext, input: { stdin?: string; terminal?: boolean } = {}): Harness => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    openShell: () =>
      okAsync({
        deps: authDepsOf(ctx),
        run: bindAuthRunEffects(ctx.authRunEffects),
        close: () => undefined,
        authRequired: true,
        defaultProfile: DEFAULT_PROFILE,
        inviteOrigin: LOOPBACK_ORIGIN,
        signIn: () =>
          createSignInInterpreter({
            deps: authDepsOf(ctx),
            run: bindAuthRunEffects(ctx.authRunEffects),
            store: memoryStore(),
            origin: () => null,
            startPage: async () => ({ origin: LOOPBACK_ORIGIN, close: async () => undefined }),
          }),
      }),
    openTerminal: () => null,
    readPasswordFromStdin: async () => input.stdin ?? '',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: '0.0.0-test',
    wait: async () => undefined,
    interruptSignal: () => new AbortController().signal,
    clients: { find: () => undefined },
  };
  return { io, out, err, run: (...args) => runAuthCommand(args, io) };
};

const ownerRows = (ctx: AppContext) =>
  ctx.db.all<{ id: string; username: string | null; password_hash: string | null; version: number }>(
    sql`SELECT id, username, password_hash, version FROM users`,
  );

const login = (ctx: AppContext, username: string, password: string) =>
  ctx.app.inject({
    method: 'POST',
    url: '/ui/login',
    headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
    payload: formBody({ username, password }),
  });

const status = (ctx: AppContext, headers: Record<string, string>) =>
  ctx.app.inject({ method: 'GET', url: '/api/status', headers: { host: LOOPBACK_HOST, ...headers } });

describe('fintrack auth setup', () => {
  it('claims the existing owner from a piped password: same row, no new user, no session', async () => {
    const ctx = await createApp();
    const { run, out, err } = harness(ctx, { stdin: PASSWORD });

    expect(await run('setup', '--username', USERNAME, '--password-stdin')).toBe(EXIT_OK);

    expect(out).toEqual([CLI_MESSAGES.ownerClaimed('rafael')]);
    expect(err).toEqual([]);
    const rows = await ownerRows(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: OWNER_USER_ID, username: 'rafael' });
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    expect(await ctx.db.select().from(sessions)).toEqual([]);
    const [code] = await ctx.db.all<{ used_at: string | null }>(sql`SELECT used_at FROM setup_codes`);
    expect(code?.used_at).not.toBeNull();
  });

  it('lets the owner log in at /ui afterwards, and the printed setup code claims nothing more', async () => {
    const ctx = await createApp();
    const startupCode = ctx.announced.join('\n');
    expect(await harness(ctx, { stdin: PASSWORD }).run('setup', '--username', USERNAME, '--password-stdin')).toBe(
      EXIT_OK,
    );

    const ok = await login(ctx, USERNAME, PASSWORD);
    expect(ok.statusCode).toBe(303);
    expect(sessionCookieOf(ok)).toBeDefined();
    expect((await login(ctx, USERNAME, 'not the password at all')).statusCode).toBe(401);

    const code = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){4}/.exec(startupCode)?.[0] ?? '';
    const reused = await ctx.app.inject({
      method: 'POST',
      url: '/ui/setup',
      headers: { ...FORM_HEADERS, host: LOOPBACK_HOST, origin: LOOPBACK_ORIGIN },
      payload: formBody({ code, username: 'mallory', password: NEW_PASSWORD }),
    });
    expect(reused.statusCode).toBe(409);
    expect((await ownerRows(ctx))[0]?.username).toBe('rafael');
  });

  it('on a re-run says who owns it, exits 0 and changes nothing', async () => {
    const ctx = await createApp();
    await harness(ctx, { stdin: PASSWORD }).run('setup', '--username', USERNAME, '--password-stdin');
    const before = await ownerRows(ctx);

    const second = harness(ctx, { stdin: NEW_PASSWORD });
    expect(await second.run('setup', '--username', 'mallory', '--password-stdin')).toBe(EXIT_OK);

    expect(second.out).toEqual([CLI_MESSAGES.alreadyClaimed('rafael')]);
    expect(await ownerRows(ctx)).toEqual(before);
  });

  it('re-running needs no terminal and no password once claimed', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const noInput = harness(ctx);
    expect(await noInput.run('setup')).toBe(EXIT_OK);
    expect(noInput.out).toEqual([CLI_MESSAGES.alreadyClaimed('rafael')]);
  });

  it('with no terminal and no --password-stdin fails with instructions and writes nothing', async () => {
    const ctx = await createApp();
    const { run, err, out } = harness(ctx);

    expect(await run('setup')).toBe(EXIT_FAILURE);

    expect(out).toEqual([]);
    expect(err.join('\n')).toContain(PROMPT_MESSAGES.noTerminal);
    expect(err.join('\n')).toContain('--password-stdin');
    expect((await ownerRows(ctx))[0]).toMatchObject({ username: null, password_hash: null });
  });

  it('refuses a weak piped password without claiming, and needs --username with --password-stdin', async () => {
    const ctx = await createApp();
    const weak = harness(ctx, { stdin: 'short' });
    expect(await weak.run('setup', '--username', USERNAME, '--password-stdin')).toBe(EXIT_FAILURE);
    expect(weak.err.join('\n')).toContain('at least 12 characters');

    const nameless = harness(ctx, { stdin: PASSWORD });
    expect(await nameless.run('setup', '--password-stdin')).toBe(EXIT_FAILURE);
    expect(nameless.err.join('\n')).toContain(PROMPT_MESSAGES.usernameRequiredWithStdin);

    expect((await ownerRows(ctx))[0]).toMatchObject({ username: null, password_hash: null });
  });

  it('never prints the password, in output or in errors', async () => {
    const ctx = await createApp();
    const run = harness(ctx, { stdin: PASSWORD });
    await run.run('setup', '--username', USERNAME, '--password-stdin');
    const weak = harness(ctx, { stdin: 'hunter2' });
    await weak.run('setup', '--username', '!', '--password-stdin');
    expect([...run.out, ...run.err, ...weak.out, ...weak.err].join('\n')).not.toMatch(
      new RegExp(`${PASSWORD}|hunter2`),
    );
  });
});

describe('fintrack auth reset-password', () => {
  /** An owner with a live session, a live token, plus a second user (no flow creates one yet) with the same. */
  const world = async () => {
    const ctx = await createApp();
    const cookie = await claimOwner(ctx);
    const { token, id: tokenId } = await mintToken(ctx, cookie, { name: 'script' });
    const now = new Date().toISOString();
    await ctx.db.insert(users).values({
      id: 'user-ana',
      username: 'ana',
      passwordHash: 'not-a-real-hash',
      role: UserRole.enum.member,
      createdAt: now,
    });
    await ctx.db.insert(sessions).values({
      id: 'ana-session',
      userId: 'user-ana',
      tokenHash: 'ana-session-hash',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await ctx.db.insert(accessTokens).values({
      id: 'ana-token',
      userId: 'user-ana',
      name: 'ana script',
      tokenHash: 'ana-token-hash',
      prefix: 'ftk_ana',
      scopes: ['fintrack:read'],
      createdAt: now,
    });
    return { ctx, cookie, token, tokenId };
  };

  it('makes the old password fail and the new one work, and kills the old sessions and tokens', async () => {
    const { ctx, cookie, token } = await world();
    expect((await status(ctx, { cookie })).statusCode).toBe(200);
    expect((await status(ctx, bearer(token))).statusCode).toBe(200);

    const { run, out, err } = harness(ctx, { stdin: NEW_PASSWORD });
    expect(await run('reset-password', '--password-stdin')).toBe(EXIT_OK);

    expect(err).toEqual([]);
    expect(out).toEqual([
      CLI_MESSAGES.passwordReset({ username: 'rafael', sessionsEnded: 1, tokensRevoked: 1 }),
      CLI_MESSAGES.sessionsEnded(1),
      CLI_MESSAGES.tokensRevoked(1),
    ]);
    expect((await login(ctx, USERNAME, PASSWORD)).statusCode).toBe(401);
    expect((await login(ctx, USERNAME, NEW_PASSWORD)).statusCode).toBe(303);
    expect((await status(ctx, { cookie })).statusCode).toBe(401);
    expect((await status(ctx, bearer(token))).statusCode).toBe(401);
  });

  it('keeps the revoked token’s row (revoked_at set) and never reports a password', async () => {
    const { ctx, tokenId } = await world();
    const { run, out, err } = harness(ctx, { stdin: NEW_PASSWORD });
    await run('reset-password', '--password-stdin');

    const stored = await authDepsOf(ctx).accessTokens.findById(OWNER_USER_ID, tokenId);
    expect(stored?.revokedAt).not.toBeNull();
    expect([...out, ...err].join('\n')).not.toContain(NEW_PASSWORD);
  });

  it('leaves every other user’s password, sessions and tokens exactly as they were', async () => {
    const { ctx } = await world();
    await harness(ctx, { stdin: NEW_PASSWORD }).run('reset-password', '--password-stdin');

    const [ana] = await ctx.db.all<{ password_hash: string; version: number }>(
      sql`SELECT password_hash, version FROM users WHERE id = 'user-ana'`,
    );
    expect(ana).toEqual({ password_hash: 'not-a-real-hash', version: 0 });
    expect(await ctx.db.all(sql`SELECT 1 FROM sessions WHERE id = 'ana-session'`)).toHaveLength(1);
    const [anaToken] = await ctx.db.all<{ revoked_at: string | null }>(
      sql`SELECT revoked_at FROM access_tokens WHERE id = 'ana-token'`,
    );
    expect(anaToken?.revoked_at).toBeNull();
  });

  it('resets a named user with --user, leaving the owner alone', async () => {
    const { ctx, cookie } = await world();
    const { run, out } = harness(ctx, { stdin: NEW_PASSWORD });
    expect(await run('reset-password', '--user', 'ANA', '--password-stdin')).toBe(EXIT_OK);

    expect(out[0]).toBe(CLI_MESSAGES.passwordReset({ username: 'ana', sessionsEnded: 1, tokensRevoked: 1 }));
    expect((await status(ctx, { cookie })).statusCode).toBe(200);
    expect((await login(ctx, USERNAME, PASSWORD)).statusCode).toBe(303);
  });

  it('answers a clear error for an unknown user — before reading a password — and changes nothing', async () => {
    const { ctx, cookie } = await world();
    const readPassword = vi.fn(async () => NEW_PASSWORD);
    const { io, err } = harness(ctx);
    const exit = await runAuthCommand(['reset-password', '--user', 'nobody', '--password-stdin'], {
      ...io,
      readPasswordFromStdin: readPassword,
    });

    expect(exit).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('nobody');
    expect(readPassword).not.toHaveBeenCalled();
    expect((await login(ctx, USERNAME, PASSWORD)).statusCode).toBe(303);
    expect((await status(ctx, { cookie })).statusCode).toBe(200);
  });

  it('points an unclaimed owner at `auth setup`', async () => {
    const ctx = await createApp();
    const { run, err } = harness(ctx, { stdin: NEW_PASSWORD });
    expect(await run('reset-password', '--password-stdin')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('auth setup');
  });

  it('with no terminal and no --password-stdin fails with instructions and changes nothing', async () => {
    const { ctx } = await world();
    const before = await ownerRows(ctx);
    const { run, err } = harness(ctx);
    expect(await run('reset-password')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain(PROMPT_MESSAGES.noTerminal);
    expect(await ownerRows(ctx)).toEqual(before);
  });
});

describe('fintrack auth setup (a lost race)', () => {
  it('reports the failure, not silence, when the owner cannot be claimed and nobody holds the login', async () => {
    const ctx = await createApp();
    await ctx.db.run(sql`DELETE FROM setup_codes`);
    await ctx.db.run(sql`DELETE FROM users`);
    const { run, err } = harness(ctx, { stdin: PASSWORD });

    expect(await run('setup', '--username', USERNAME, '--password-stdin')).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain('setup_unavailable');
  });
});

describe('fintrack auth (arguments)', () => {
  it('prints the help for no subcommand and exits 0', async () => {
    const ctx = await createApp();
    const { run, out } = harness(ctx);
    expect(await run()).toBe(EXIT_OK);
    expect(out).toEqual([AUTH_HELP]);
  });

  it.each([
    [['frobnicate'], 'unknown auth command'],
    [['setup', '--bogus'], 'bogus'],
    [['setup', '--username'], 'username'],
    [['setup', '--username', 'a b', '--password-stdin'], 'username'],
    [['reset-password', '--username', 'x'], 'username'],
    [['reset-password', 'ana'], 'unexpected argument "ana"'],
    [['setup', 'claude-code'], 'unexpected argument "claude-code"'],
    [['reset-password', '--user', '   ', '--password-stdin'], 'at least 1'],
  ])('rejects %j without touching the database', async (args, mention) => {
    const ctx = await createApp();
    const { run, err } = harness(ctx, { stdin: PASSWORD });
    expect(await run(...args)).toBe(EXIT_FAILURE);
    expect(err.join('\n')).toContain(mention);
    expect((await ownerRows(ctx))[0]).toMatchObject({ username: null, password_hash: null });
  });
});

describe('positional arguments', () => {
  it('lets `setup` take one client and refuses a second', () => {
    expect(parseClaimArgs(['claude-code', '--password-stdin'], SETUP_POSITIONALS)).toMatchObject({
      positionals: ['claude-code'],
    });
    expect(parseClaimArgs(['claude-code', 'extra'], SETUP_POSITIONALS)).toEqual({
      error: CLI_MESSAGES.unexpectedArgument('extra'),
    });
  });

  it('refuses any positional for the auth subcommands', () => {
    expect(parseClaimArgs(['anything'], AUTH_POSITIONALS)).toEqual({
      error: CLI_MESSAGES.unexpectedArgument('anything'),
    });
  });
});

describe('no flow can create a user', () => {
  it('claiming and resetting only ever update the owner row', async () => {
    const ctx = await createApp();
    await harness(ctx, { stdin: PASSWORD }).run('setup', '--username', USERNAME, '--password-stdin');
    await harness(ctx, { stdin: NEW_PASSWORD }).run('reset-password', '--password-stdin');
    await harness(ctx, { stdin: NEW_PASSWORD }).run('reset-password', '--user', 'ghost', '--password-stdin');
    expect((await ownerRows(ctx)).map((row) => row.id)).toEqual([OWNER_USER_ID]);
  });
});

describe('fintrack auth — the world changing between planning and writing', () => {
  /** The CLI's shell, with `beforeWrite` running right before the first flow it executes (after the plan was made). */
  const racing = (ctx: AppContext, input: { stdin: string }, beforeWrite: () => Promise<void>) => {
    const { io, out, err } = harness(ctx, input);
    let pending = true;
    const raced: CliIo = {
      ...io,
      openShell: () =>
        io.openShell().map((shell) => ({
          ...shell,
          run: (flow) => {
            const first = pending;
            pending = false;
            return ResultAsync.fromSafePromise(first ? beforeWrite() : Promise.resolve()).andThen(() =>
              shell.run(flow),
            );
          },
        })),
    };
    return { io: raced, out, err };
  };

  it('setup that lost the claim to another process answers who holds it, and exits 0', async () => {
    const ctx = await createApp();
    const { io, out, err } = racing(ctx, { stdin: NEW_PASSWORD }, async () => {
      await harness(ctx, { stdin: PASSWORD }).run('setup', '--username', USERNAME, '--password-stdin');
    });

    expect(await runAuthCommand(['setup', '--username', 'mallory', '--password-stdin'], io)).toBe(EXIT_OK);

    expect(out).toEqual([CLI_MESSAGES.alreadyClaimed('rafael')]);
    expect(err).toEqual([]);
    expect((await ownerRows(ctx))[0]).toMatchObject({ id: OWNER_USER_ID, username: 'rafael' });
  });

  it('reset-password whose target lost its login meanwhile reports the failure and exits non-zero', async () => {
    const ctx = await createApp();
    await harness(ctx, { stdin: PASSWORD }).run('setup', '--username', USERNAME, '--password-stdin');
    const { io, out, err } = racing(ctx, { stdin: NEW_PASSWORD }, async () => {
      await ctx.db.run(sql`UPDATE users SET password_hash = NULL WHERE id = ${OWNER_USER_ID}`);
    });

    expect(await runAuthCommand(['reset-password', '--password-stdin'], io)).toBe(EXIT_FAILURE);

    expect(err.join('\n')).toContain('owner_unclaimed');
    expect(out.join('\n')).not.toContain('password was reset');
  });
});
