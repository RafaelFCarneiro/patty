import {
  CLI_MESSAGES,
  defaultCliIo,
  ensureOwnerClaimed,
  fail,
  parseClaimArgs,
  runAuthCommand,
  exitCodeOf,
  type CliIo,
} from './authCli.js';
import { CliCommand, EXIT_FAILURE, SETUP_POSITIONALS } from './common/cli.js';
import { runGuidedSetup } from './setup.js';

const runSetupCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseClaimArgs(args, SETUP_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const [client] = parsed.positionals;
  return runGuidedSetup(client, () => ensureOwnerClaimed(io, parsed.options));
};

export const runCli = async (args: readonly string[], io: CliIo = defaultCliIo()): Promise<number> => {
  const [command, ...rest] = args;
  try {
    return CliCommand.parse(command) === CliCommand.enum.setup
      ? await runSetupCommand(rest, io)
      : await runAuthCommand(rest, io);
  } catch (cause) {
    io.err(CLI_MESSAGES.failure(cause instanceof Error ? cause.message : String(cause)));
    return EXIT_FAILURE;
  }
};
