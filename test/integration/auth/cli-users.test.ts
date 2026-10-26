import { sql } from 'drizzle-orm';
import { okAsync } from 'neverthrow';
import { describe, expect, it } from 'vitest';
import { bindAuthRunEffects } from '../../../src/composition/auth.js';
import { runCli } from '../../../src/diplomat/cli/commands.js';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from '../../../src/diplomat/cli/io.js';
import { runUsersCommand, USERS_HELP } from '../../../src/diplomat/cli/commands/users.js';
import { INVITE_PATH } from '../../../src/models/auth/origin.js';
import { DEFAULT_PROFILE } from '../../../src/models/auth/sign-in.js';
import { NPX_COMMAND } from '../../../src/models/package.js';
import type { AppContext } from '../app-builder.js';
import { authDepsOf, bearer, claimOwner, LOOPBACK_ORIGIN, sessionCookieOf, useAuthApp } from './helpers.js';
import {
  addUser,
  claim,
  countRows,
  get,
  inviteRows,
  liveTokenCount,
  loginAs,
  mintFor,
  userRow,
  userRows,
  USERS_URL,
} from './user-helpers.js';
import { unusedExporter } from '../../unit/fixtures/exporter.js';
import { unusedDemo } from '../../unit/fixtures/demo.js';

const createApp = useAuthApp();

type Harness = { out: string[]; err: string[]; run: (...args: string[]) => Promise<number>; io: CliIo };

/** The CLI against the test app's own database — what `main.ts` wires with `openShell`, minus the process. It has no
 *  password to give: the terminal is the trusted operator, so reading one is a test failure. */
const harness = (ctx: AppContext, inviteOrigin: string | null = LOOPBACK_ORIGIN): Harness => {
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
        inviteOrigin,
        signIn: () => {
          throw new Error('users commands never sign anything in');
        },
      }),
    openTerminal: () => null,
    readPasswordFromStdin: async () => {
      throw new Error('the terminal operator is never asked for a password');
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: '0.0.0-test',
    wait: async () => undefined,
    interruptSignal: () => new AbortController().signal,
    clients: { find: () => undefined },
    exporter: unusedExporter,
    demo: unusedDemo,
  };
  return { out, err, io, run: (...args) => runUsersCommand(args, io) };
};

const CODE = /Code: ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){4})/;
const LINK = /Link: (\S+)/;

describe('fintrack users — routed through the command line', () => {
  it('is a command of the CLI, listed in the usage', async () => {
    const ctx = await createApp();
    const cli = harness(ctx);
    expect(await runCli(['users'], cli.io)).toBe(EXIT_OK);
    expect(cli.out.join('\n')).toContain(`Usage: ${NPX_COMMAND} users <command>`);
    const help = harness(ctx);
    await runCli(['--help'], help.io);
    expect(help.out.join('\n')).toContain('users <command>');
  });

  it('prints its own help with no subcommand, and fails on an unknown one', async () => {
    const ctx = await createApp();
    const none = harness(ctx);
    expect(await none.run()).toBe(EXIT_OK);
    expect(none.out).toEqual([USERS_HELP]);

    const unknown = harness(ctx);
    expect(await unknown.run('delete', 'ana')).toBe(EXIT_FAILURE);
    expect(unknown.err.join('\n')).toContain('unknown users command "delete"');
    expect(unknown.out).toEqual([]);
  });
});

describe('users list', () => {
  it('shows everyone with role, status and last login', async () => {
    const ctx = await createApp();
    const owner = await claimOwner(ctx);
    await addUser(ctx, owner, 'ana');
    const cli = harness(ctx);
    await cli.run('invite', 'bob');
    cli.out.length = 0;

    expect(await cli.run('list')).toBe(EXIT_OK);

    const lines = cli.out.join('\n').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^rafael\s+admin\s+active\s+last login: 20/);
    expect(lines[1]).toMatch(/^ana\s+member\s+active/);
    expect(lines[2]).toMatch(/^bob\s+member\s+invited\s+last login: never/);
  });

  it('refuses extra arguments', async () => {
    const cli = harness(await createApp());
    expect(await cli.run('list', 'ana')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain('unexpected argument "ana"');
  });
});

describe('users invite', () => {
  it('creates the user and prints a link and a code that claim it — shown once, with no password asked', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx);

    expect(await cli.run('invite', 'Ana')).toBe(EXIT_OK);

    const text = cli.out.join('\n');
    const code = CODE.exec(text)![1]!;
    expect(LINK.exec(text)![1]).toBe(`${LOOPBACK_ORIGIN}/ui/access/invite?code=${code}`);
    expect(text).toContain('"ana" (member)');
    expect(text).toContain('you never see it');
    expect(await userRow(ctx, 'ana')).toMatchObject({ role: 'member', password_hash: null });
    // Issued by the terminal, so attributed to no user.
    expect(await ctx.db.all(sql`SELECT created_by FROM invites`)).toEqual([{ created_by: null }]);

    const claimed = await claim(ctx, code);
    expect(claimed.statusCode).toBe(303);
    expect(sessionCookieOf(claimed)).toBeDefined();
  });

  it('prints only the code and the page path, never a link, when no public origin is configured', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx, null);

    expect(await cli.run('invite', 'Ana')).toBe(EXIT_OK);
    expect(await cli.run('reissue', 'ana')).toBe(EXIT_OK);

    const text = cli.out.join('\n');
    expect(text).not.toMatch(/Link:|https?:\/\//);
    expect(text).not.toContain('?code=');
    expect(text).toContain(`Page: ${INVITE_PATH}`);
    expect(CODE.exec(text)).not.toBeNull();
  });

  it('invites an administrator with --admin, in either order', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx);
    expect(await cli.run('invite', '--admin', 'boss')).toBe(EXIT_OK);
    expect(await cli.run('invite', 'chief', '--admin')).toBe(EXIT_OK);
    expect(await userRow(ctx, 'boss')).toMatchObject({ role: 'admin' });
    expect(await userRow(ctx, 'chief')).toMatchObject({ role: 'admin' });
  });

  it('refuses a taken or invalid username and creates nobody', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx);

    expect(await cli.run('invite', 'RAFAEL')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain('username_taken');
    expect(await cli.run('invite', 'ab')).toBe(EXIT_FAILURE);
    expect(await cli.run('invite')).toBe(EXIT_FAILURE);
    expect(await cli.run('invite', 'ana', 'bob')).toBe(EXIT_FAILURE);
    expect(await userRows(ctx)).toHaveLength(1);
    expect(await inviteRows(ctx)).toEqual([]);
  });
});

describe('users reissue', () => {
  it('prints a new invite, and for a claimed user ends everything they hold', async () => {
    const ctx = await createApp();
    const owner = await claimOwner(ctx);
    const ana = await addUser(ctx, owner, 'ana');
    const pat = await mintFor(ctx, ana.cookie);
    const cli = harness(ctx);

    expect(await cli.run('reissue', 'ana')).toBe(EXIT_OK);

    expect(CODE.test(cli.out.join('\n'))).toBe(true);
    expect(cli.out.join('\n')).toContain('Password cleared; sessions ended: 1, tokens and sign-ins revoked: 1');
    expect(await userRow(ctx, 'ana')).toMatchObject({ password_hash: null });
    expect((await get(ctx, ana.cookie, '/ui/access/tokens')).statusCode).toBe(303);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/status', headers: bearer(pat.token) })).statusCode).toBe(
      401,
    );
  });

  it('refuses the only admin, even from the terminal', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx);
    expect(await cli.run('reissue', 'rafael')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain('last_admin');
    expect(cli.err.join('\n')).toContain('Make another user an administrator first');
  });

  it('points at the other command when the user is disabled, and says so for an unknown one', async () => {
    const ctx = await createApp();
    const owner = await claimOwner(ctx);
    await addUser(ctx, owner, 'ana');
    const cli = harness(ctx);
    await cli.run('disable', 'ana');

    expect(await cli.run('reissue', 'ana')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain(`${NPX_COMMAND} users enable ana`);
    expect(await cli.run('reissue', 'nobody')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain('unknown_user');
  });
});

describe('users disable and enable', () => {
  it('disables, reporting what it ended, and enables again without reviving anything', async () => {
    const ctx = await createApp();
    const owner = await claimOwner(ctx);
    const ana = await addUser(ctx, owner, 'ana');
    await mintFor(ctx, ana.cookie);
    const cli = harness(ctx);

    expect(await cli.run('disable', 'ANA')).toBe(EXIT_OK);
    expect(cli.out.join('\n')).toBe('Disabled "ana". sessions ended: 1, tokens and sign-ins revoked: 1.');
    expect(await countRows(ctx, 'sessions', ana.userId)).toBe(0);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
    expect((await loginAs(ctx, 'ana')).statusCode).toBe(401);

    cli.out.length = 0;
    expect(await cli.run('enable', 'ana')).toBe(EXIT_OK);
    expect(cli.out.join('\n')).toContain('stay revoked');
    expect((await loginAs(ctx, 'ana')).statusCode).toBe(303);
    expect(await liveTokenCount(ctx, ana.userId)).toBe(0);
  });

  it('refuses to disable the last active admin, and an unknown user, and needs a name', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx);

    expect(await cli.run('disable', 'rafael')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain('last_admin');
    expect(await userRow(ctx, 'rafael')).toMatchObject({ disabled_at: null });
    expect(await cli.run('disable', 'nobody')).toBe(EXIT_FAILURE);
    expect(await cli.run('enable')).toBe(EXIT_FAILURE);
  });

  it('disables the owner once another admin stands — the owner is the first admin, not special', async () => {
    const ctx = await createApp();
    const owner = await claimOwner(ctx);
    const boss = await addUser(ctx, owner, 'boss', 'admin');
    const cli = harness(ctx);

    expect(await cli.run('disable', 'rafael')).toBe(EXIT_OK);

    expect(await userRow(ctx, 'rafael')).toMatchObject({ disabled_at: expect.any(String) });
    expect((await get(ctx, boss.cookie, USERS_URL)).statusCode).toBe(200);
    expect((await get(ctx, owner, USERS_URL)).statusCode).toBe(303);
  });
});

describe('users role', () => {
  it('sets a role, and refuses a bad role, a missing one, or demoting the last admin', async () => {
    const ctx = await createApp();
    const owner = await claimOwner(ctx);
    await addUser(ctx, owner, 'ana');
    const cli = harness(ctx);

    expect(await cli.run('role', 'ana', 'admin')).toBe(EXIT_OK);
    expect(cli.out.join('\n')).toBe('"ana" is now admin.');
    expect(await userRow(ctx, 'ana')).toMatchObject({ role: 'admin' });

    expect(await cli.run('role', 'ana', 'owner')).toBe(EXIT_FAILURE);
    expect(await cli.run('role', 'ana')).toBe(EXIT_FAILURE);
    expect(await cli.run('role', 'ana', 'member')).toBe(EXIT_OK);

    expect(await cli.run('role', 'rafael', 'member')).toBe(EXIT_FAILURE);
    expect(cli.err.join('\n')).toContain('last_admin');
    expect(await userRow(ctx, 'rafael')).toMatchObject({ role: 'admin' });
  });
});

describe('what the terminal does not need', () => {
  it('asks for no password anywhere — the operator holds the database key', async () => {
    const ctx = await createApp();
    await claimOwner(ctx);
    const cli = harness(ctx);
    // `readPasswordFromStdin` throws if any command reaches for it.
    for (const args of [
      ['invite', 'ana'],
      ['reissue', 'ana'],
      ['disable', 'ana'],
      ['enable', 'ana'],
      ['role', 'ana', 'admin'],
    ]) {
      expect(await cli.run(...args)).toBe(EXIT_OK);
    }
  });
});
