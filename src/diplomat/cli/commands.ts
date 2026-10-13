import { DatabaseAheadError } from '../../common/databaseAhead.js';
import { CliCommand } from '../../wire/in/cli.js';
import { NPX_COMMAND } from '../../models/package.js';
import { runAuthCommand } from './commands/auth.js';
import { runLogin, runLogout } from './commands/login.js';
import { runSetupCommand } from './commands/setup.js';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.js';
import { CLI_MESSAGES } from './messages.js';

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
export const runCli = async (args: readonly string[], io: CliIo): Promise<number> => {
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
