import {
  EXIT_FAILURE,
  CLI_MESSAGES,
  defaultCliIo,
  ensureOwnerClaimed,
  fail,
  parseClaimArgs,
  runAuthCommand,
  exitCodeOf,
  type CliIo,
} from './authCli.js';
import { CliCommand } from './common/cli.js';
import { runGuidedSetup } from './setup.js';

const runSetupCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseClaimArgs(args);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const [client] = parsed.positionals;
  return runGuidedSetup(client, () => ensureOwnerClaimed(io, parsed.options));
};

/**
 * The binary's command mode (`fintrack setup …`, `fintrack auth …`): everything that is a command rather than the
 * server. Loaded lazily by `main.ts` — only these commands pay for it. Resolves the process exit code.
 */
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
