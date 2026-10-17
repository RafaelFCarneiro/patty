import type { ResultAsync } from 'neverthrow';
import { z } from 'zod';
import { formatAppError, type AppError } from '../../../common/errors.js';
import {
  disableUser,
  enableUser,
  inviteUser,
  listUsers,
  reissueInvite,
  resolveUserId,
  setRole,
  type UserChange,
} from '../../../controllers/users.js';
import { inviteLink } from '../../../logic/auth/users.js';
import { UserRole } from '../../../models/auth/owner.js';
import { UsernameSchema } from '../../../models/auth/password.js';
import type { Actor, IssuedInvite } from '../../../models/auth/users.js';
import { NPX_COMMAND } from '../../../models/package.js';
import {
  InviteOptionsSchema,
  TargetUsernameSchema,
  USERS_POSITIONALS,
  UsersSubcommand,
  type InviteOptions,
} from '../../../wire/in/cli.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  exitCodeOf,
  fail,
  failed,
  parseFlags,
  withShell,
  type CliIo,
  type Shell,
} from '../io.js';
import { CLI_MESSAGES } from '../messages.js';

export const USERS_HELP = `
Usage: ${NPX_COMMAND} users <command>

Commands:
  list                          Everyone who can sign in, with role, status and last login
  invite <username> [--admin]   Create a user and print a one-time invite link and code (members unless --admin)
  reissue <username>            A new invite; for a user who already claimed one, also clears their password and ends
                                every session, token and sign-in they hold
  disable <username>            Stop them logging in and end every session, token and sign-in they hold
  enable <username>             Let them log in again (earlier sessions and tokens stay revoked)
  role <username> <member|admin>

Run from a terminal that can open the database: like \`auth setup\`, it needs no password. People choose their own
password by claiming the invite; users are disabled, never deleted, and the instance always keeps one active admin.
`.trimStart();

// The terminal is the trusted local operator: it holds the database key, so it has no session, no user and no step-up.
const NEEDS_USERNAME = 'a username is required';

const TERMINAL: Actor = { kind: 'terminal' };

// What each refusal says on this edge, in this edge's vocabulary: the domain's message is neutral.
const REFUSAL_HINT: Readonly<Partial<Record<AppError['code'], (username: string) => string>>> = {
  user_disabled: (username) => `Run \`${NPX_COMMAND} users enable ${username}\` first.`,
  last_admin: () => 'Make another user an administrator first.',
};

const refused = (io: CliIo, error: AppError, username?: string): number => {
  const hint = username === undefined ? undefined : REFUSAL_HINT[error.code]?.(username);
  return failed(io, hint === undefined ? formatAppError(error) : `${formatAppError(error)} ${hint}`);
};

type Worked<T> = ResultAsync<T, AppError>;

/** Opens the shell, names the one user the command is about, and hands both to `work`. */
const aboutUser = (
  io: CliIo,
  rawUsername: string | undefined,
  work: (shell: Shell, userId: string, username: string) => Promise<number>,
) =>
  withShell(
    io,
    async (shell) => {
      const named = TargetUsernameSchema.safeParse(rawUsername);
      if (!named.success) return exitCodeOf(fail(io, NEEDS_USERNAME));
      const userId = await resolveUserId(shell.deps, named.data);
      return userId.isErr() ? refused(io, userId.error) : work(shell, userId.value, named.data);
    },
    EXIT_FAILURE,
  );

const printIssued = (io: CliIo, shell: Shell, issued: IssuedInvite): void => {
  io.out(CLI_MESSAGES.invited(issued, inviteLink(shell.inviteOrigin, issued.code)));
};

const list = (io: CliIo): Promise<number> =>
  withShell(
    io,
    async (shell) => {
      const users = await listUsers(shell.deps, TERMINAL);
      if (users.isErr()) return refused(io, users.error);
      io.out(users.value.length === 0 ? CLI_MESSAGES.noUsers : users.value.map(CLI_MESSAGES.userRow).join('\n'));
      return EXIT_OK;
    },
    EXIT_FAILURE,
  );

const invite = (positionals: readonly string[], options: InviteOptions, io: CliIo): Promise<number> => {
  const username = UsernameSchema.safeParse(positionals[0]);
  if (!username.success) {
    return Promise.resolve(exitCodeOf(fail(io, username.error.issues[0]?.message ?? NEEDS_USERNAME)));
  }
  return withShell(
    io,
    async (shell) => {
      const input = { username: username.data, role: options.role };
      const issued = await shell.run(() => inviteUser(shell.deps, TERMINAL, input));
      if (issued.isErr()) return refused(io, issued.error);
      printIssued(io, shell, issued.value);
      return EXIT_OK;
    },
    EXIT_FAILURE,
  );
};

const reissue = (username: string | undefined, io: CliIo): Promise<number> =>
  aboutUser(io, username, async (shell, userId, name) => {
    const issued = await shell.run(() => reissueInvite(shell.deps, TERMINAL, userId));
    if (issued.isErr()) return refused(io, issued.error, name);
    printIssued(io, shell, issued.value);
    io.out(CLI_MESSAGES.reissueEnded(issued.value.revoked));
    return EXIT_OK;
  });

const report = (
  io: CliIo,
  changed: Awaited<Worked<UserChange>>,
  say: (change: UserChange) => string,
  name: string,
): number => {
  if (changed.isErr()) return refused(io, changed.error, name);
  io.out(say(changed.value));
  return EXIT_OK;
};

const disable = (username: string | undefined, io: CliIo): Promise<number> =>
  aboutUser(io, username, async (shell, userId, name) =>
    report(
      io,
      await shell.run(() => disableUser(shell.deps, TERMINAL, userId)),
      (change) => CLI_MESSAGES.disabled(name, change.revoked),
      name,
    ),
  );

const enable = (username: string | undefined, io: CliIo): Promise<number> =>
  aboutUser(io, username, async (shell, userId, name) =>
    report(io, await shell.run(() => enableUser(shell.deps, TERMINAL, userId)), () => CLI_MESSAGES.enabled(name), name),
  );

const role = (username: string | undefined, rawRole: string | undefined, io: CliIo): Promise<number> => {
  const chosen = UserRole.safeParse(rawRole);
  if (!chosen.success)
    return Promise.resolve(exitCodeOf(fail(io, `a role is required: ${UserRole.options.join(' or ')}`)));
  return aboutUser(io, username, async (shell, userId, name) =>
    report(
      io,
      await shell.run(() => setRole(shell.deps, TERMINAL, { userId, role: chosen.data })),
      () => CLI_MESSAGES.roleSet(name, chosen.data),
      name,
    ),
  );
};

const NO_FLAGS = z.object({});
const INVITE_FLAGS = { admin: { type: 'boolean' } } as const;

const parsedArguments = (subcommand: UsersSubcommand, args: readonly string[]) =>
  subcommand === UsersSubcommand.enum.invite
    ? parseFlags(args, INVITE_FLAGS, InviteOptionsSchema, USERS_POSITIONALS.invite)
    : parseFlags(args, {}, NO_FLAGS, USERS_POSITIONALS[subcommand]);

export const runUsersCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const [name, ...rest] = args;
  if (name === undefined) {
    io.out(USERS_HELP);
    return EXIT_OK;
  }
  const subcommand = UsersSubcommand.safeParse(name);
  if (!subcommand.success) {
    io.err(CLI_MESSAGES.failure(`unknown users command "${name}"`));
    io.err(USERS_HELP);
    return EXIT_FAILURE;
  }
  const parsed = parsedArguments(subcommand.data, rest);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const [first, second] = parsed.positionals;
  const handlers: Readonly<Record<UsersSubcommand, () => Promise<number>>> = {
    list: () => list(io),
    invite: () => invite(parsed.positionals, parsed.options as InviteOptions, io),
    reissue: () => reissue(first, io),
    disable: () => disable(first, io),
    enable: () => enable(first, io),
    role: () => role(first, second, io),
  };
  return handlers[subcommand.data]();
};
