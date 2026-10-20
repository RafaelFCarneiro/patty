import { formatAppError } from '../../../common/errors.js';
import {
  claimOwnerLocally,
  claimRaceWinnerOf,
  findResetTarget,
  ownerClaimPlan,
  resetPassword,
} from '../../../controllers/auth.js';
import type { PasswordReset } from '../../../models/auth/password.js';
import { NPX_COMMAND } from '../../../models/package.js';
import {
  AUTH_POSITIONALS,
  AuthSubcommand,
  ClaimOptionsSchema,
  PASSWORD_STDIN_FLAG,
  ResetOptionsSchema,
  type ClaimOptions,
  type ResetOptions,
} from '../../../wire/in/cli.js';
import {
  EXIT_FAILURE,
  EXIT_OK,
  exitCodeOf,
  exitCodeOfPrompt,
  fail,
  failed,
  parseFlags,
  withShell,
  type CliIo,
} from '../io.js';
import { CLI_MESSAGES } from '../messages.js';
import { collectNewCredentials, collectNewPassword, type PromptIo } from '../prompt.js';

export const AUTH_HELP = `
Usage: ${NPX_COMMAND} auth <command>

Commands:
  setup            Choose the owner's username and password (once; claims the existing owner, never creates a user)
  reset-password   Choose a new password and end every session and access token of that user

Options:
  --username <name>  (setup) the owner's username — required with --${PASSWORD_STDIN_FLAG}
  --user <name>      (reset-password) whose password; default: the owner
  --${PASSWORD_STDIN_FLAG}   read the password from stdin instead of asking (scripted installs; stdin must not be a terminal)
`.trimStart();

const withPromptIo = async <T>(
  io: CliIo,
  options: { passwordStdin: boolean },
  work: (promptIo: PromptIo) => Promise<T>,
): Promise<T> => {
  const terminal = options.passwordStdin ? null : io.openTerminal();
  try {
    return await work({ terminal, readPasswordFromStdin: io.readPasswordFromStdin });
  } finally {
    terminal?.close();
  }
};

/** `EXIT_OK` = the owner holds a login when this returns (claimed now or before); anything else = nothing was
 *  written, and is the exit code to end with. */
export const ensureOwnerClaimed = (io: CliIo, options: ClaimOptions): Promise<number> =>
  withShell(
    io,
    async (shell) => {
      const plan = await ownerClaimPlan(shell.deps);
      if (plan.kind === 'skip') {
        io.out(CLI_MESSAGES.alreadyClaimed(plan.username));
        return EXIT_OK;
      }

      const credentials = await withPromptIo(io, options, (promptIo) => collectNewCredentials(promptIo, options));
      if (credentials.isErr()) return exitCodeOfPrompt(io, credentials.error);

      const claimed = await shell.run(() => claimOwnerLocally(shell.deps, credentials.value));
      if (claimed.isOk()) {
        io.out(CLI_MESSAGES.ownerClaimed(claimed.value.username));
        return EXIT_OK;
      }
      const winner = await claimRaceWinnerOf(shell.deps, claimed.error);
      if (winner) {
        io.out(CLI_MESSAGES.alreadyClaimed(winner.username));
        return EXIT_OK;
      }
      return failed(io, formatAppError(claimed.error));
    },
    EXIT_FAILURE,
  );

const reportReset = (io: CliIo, reset: PasswordReset): void => {
  io.out(CLI_MESSAGES.passwordReset(reset));
  io.out(CLI_MESSAGES.sessionsEnded(reset.sessionsEnded));
  io.out(CLI_MESSAGES.tokensRevoked(reset.tokensRevoked));
};

const resetUserPassword = (io: CliIo, options: ResetOptions): Promise<number> =>
  withShell(
    io,
    async (shell) => {
      // Resolve the user before asking for anything: a typo'd `--user` should not cost a typed password.
      const target = await findResetTarget(shell.deps, options.user);
      if (target.isErr()) return failed(io, formatAppError(target.error));

      const password = await withPromptIo(io, options, (promptIo) => {
        promptIo.terminal?.tell(CLI_MESSAGES.resetting(target.value.username));
        return collectNewPassword(promptIo, options);
      });
      if (password.isErr()) return exitCodeOfPrompt(io, password.error);

      const reset = await shell.run(() =>
        resetPassword(shell.deps, { username: options.user, password: password.value }),
      );
      if (reset.isErr()) return failed(io, formatAppError(reset.error));
      reportReset(io, reset.value);
      return EXIT_OK;
    },
    EXIT_FAILURE,
  );

const CLAIM_FLAGS = { [PASSWORD_STDIN_FLAG]: { type: 'boolean' }, username: { type: 'string' } } as const;
const RESET_FLAGS = { [PASSWORD_STDIN_FLAG]: { type: 'boolean' }, user: { type: 'string' } } as const;

export const parseClaimArgs = (args: readonly string[], maxPositionals: number) =>
  parseFlags(args, CLAIM_FLAGS, ClaimOptionsSchema, maxPositionals);

export const runAuthCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const [name, ...rest] = args;
  if (name === undefined) {
    io.out(AUTH_HELP);
    return EXIT_OK;
  }
  const subcommand = AuthSubcommand.safeParse(name);
  if (!subcommand.success) {
    io.err(CLI_MESSAGES.failure(`unknown auth command "${name}"`));
    io.err(AUTH_HELP);
    return EXIT_FAILURE;
  }

  if (subcommand.data === AuthSubcommand.enum.setup) {
    const parsed = parseClaimArgs(rest, AUTH_POSITIONALS);
    if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
    return ensureOwnerClaimed(io, parsed.options);
  }
  const parsed = parseFlags(rest, RESET_FLAGS, ResetOptionsSchema, AUTH_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  return resetUserPassword(io, parsed.options);
};
