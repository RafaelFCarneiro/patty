import { CliCommand } from '../../wire/in/cli.js';
import { NPX_COMMAND } from '../../models/package.js';
import { runAuthCommand } from './commands/auth.js';
import { runDbCommand } from './commands/db.js';
import { runDemoCommand } from './commands/demo.js';
import { runKeyCommand } from './commands/key.js';
import { runLogin, runLogout } from './commands/login.js';
import { runSetupCommand } from './commands/setup.js';
import { runUsersCommand } from './commands/users.js';
import { EXIT_FAILURE, EXIT_OK, type CliIo } from './io.js';
import { reasonOf } from '../../models/error.js';
import { CLI_MESSAGES } from './messages.js';

const HELP_ARGUMENTS: readonly string[] = ['help', '--help', '-h'];

export const USAGE = `
Usage: ${NPX_COMMAND} <command>

Commands:
  setup <client>   Claim the owner, write the MCP client's config entry, and offer to sign that client in
  login            Sign a client in from this terminal (opens a browser approval, saves it to the OS keychain)
  logout           Revoke the saved sign-in and remove it from the keychain
  auth <command>   Owner login: setup, reset-password
  users <command>  Manage who can sign in: list, invite, reissue, disable, enable, role
  key <command>    Export the database key (export --to <file>) to move an npm install to Docker
  db <command>     Export an encrypted snapshot of the database (export --to <file>)
  demo             Try FinTrack on throwaway sample data, on its own port (--country, --reset)

The setup, auth, users, key and db commands print their own help when run with no arguments. With no command at all, FinTrack runs as an MCP server (stdio).
`.trimStart();

type CommandRunner = (rest: readonly string[], io: CliIo) => Promise<number>;

// Exhaustive by type: a command added to `CliCommand` without a runner fails to compile.
const RUNNERS = {
  setup: runSetupCommand,
  login: runLogin,
  logout: runLogout,
  auth: runAuthCommand,
  users: runUsersCommand,
  key: runKeyCommand,
  db: runDbCommand,
  demo: runDemoCommand,
} as const satisfies Record<CliCommand, CommandRunner>;

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
    return await RUNNERS[known.data](rest, io);
  } catch (cause) {
    io.err(CLI_MESSAGES.failure(reasonOf(cause)));
    return EXIT_FAILURE;
  }
};
