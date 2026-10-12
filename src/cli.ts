import {
  CLI_MESSAGES,
  defaultCliIo,
  ensureOwnerClaimed,
  fail,
  parseFlags,
  runAuthCommand,
  exitCodeOf,
  type CliIo,
} from './authCli.js';
import { CliCommand, EXIT_FAILURE, EXIT_OK, PASSWORD_STDIN_FLAG, SETUP_POSITIONALS } from './common/cli.js';
import { DatabaseAheadError } from './diplomat/db/versionGuard.js';
import { offerSignIn, runLogin, runLogout } from './loginCli.js';
import { NPX_COMMAND } from './models/auth.js';
import { runGuidedSetup } from './setup.js';
import { SetupOptionsSchema } from './wire/in/cli.js';

const SETUP_FLAGS = {
  [PASSWORD_STDIN_FLAG]: { type: 'boolean' },
  username: { type: 'string' },
  profile: { type: 'string' },
} as const;

const HELP_ARGUMENTS: readonly string[] = ['help', '--help', '-h'];

export const USAGE = `
Usage: ${NPX_COMMAND} <command>

Commands:
  setup <client>   Claim the owner, write the MCP client's config entry, and offer to sign that client in
  login            Sign a client in from this terminal (opens a browser approval, saves it to the OS keychain)
  logout           Revoke the saved sign-in and remove it from the keychain
  auth <command>   Owner login: setup, reset-password

The setup and auth commands print their own help when run with no arguments. With no command at all, FinTrack runs as an MCP server (stdio).
`.trimStart();

const runSetupCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, SETUP_FLAGS, SetupOptionsSchema, SETUP_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const [client] = parsed.positionals;
  return runGuidedSetup(
    client,
    () => ensureOwnerClaimed(io, parsed.options),
    (profile) => offerSignIn(io, profile),
    parsed.options.profile,
  );
};

const runKnownCommand = (command: CliCommand, rest: readonly string[], io: CliIo): Promise<number> => {
  switch (command) {
    case CliCommand.enum.setup:
      return runSetupCommand(rest, io);
    case CliCommand.enum.login:
      return runLogin(rest, io);
    case CliCommand.enum.logout:
      return runLogout(rest, io);
    case CliCommand.enum.auth:
      return runAuthCommand(rest, io);
    default: {
      const _exhaustive: never = command;
      throw new Error(`unmapped command: ${String(_exhaustive)}`);
    }
  }
};

/** Every argument is a command: an unknown one prints the usage and fails — it never falls through to starting a
 *  server, which is what an old or stale build once did with `auth setup`. */
export const runCli = async (args: readonly string[], io: CliIo = defaultCliIo()): Promise<number> => {
  const [command, ...rest] = args;
  if (command === undefined || HELP_ARGUMENTS.includes(command)) {
    io.out(USAGE);
    return EXIT_OK;
  }
  const known = CliCommand.safeParse(command);
  if (!known.success) {
    io.err(CLI_MESSAGES.failure(`unknown command "${command}"`));
    io.err(USAGE);
    return EXIT_FAILURE;
  }
  try {
    return await runKnownCommand(known.data, rest, io);
  } catch (cause) {
    io.err(
      cause instanceof DatabaseAheadError
        ? cause.message
        : CLI_MESSAGES.failure(cause instanceof Error ? cause.message : String(cause)),
    );
    return EXIT_FAILURE;
  }
};
