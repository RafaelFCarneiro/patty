import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { ZodType, ZodTypeDef } from 'zod';
import { runEffects } from '@rfc0/effect-runner';
import { AUTH_APPLIERS, bindAuthRunEffects, createAuthDeps } from './authRuntime.js';
import { formatAppError } from './common/errors.js';
import { AuthSubcommand } from './common/cli.js';
import { loadConfig } from './config.js';
import { claimedOwnerOf, claimOwnerLocally, findResetTarget, resetPassword } from './controllers/auth.js';
import type { AuthDeps, RunEffects } from './controllers/deps.js';
import { bootstrap } from './diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase } from './diplomat/db/driver.js';
import { createEngineContext } from './diplomat/db/engine.js';
import { collectNewCredentials, collectNewPassword, PROMPT_MESSAGES, type PromptIo } from './diplomat/cli/prompt.js';
import {
  isInteractive,
  openTerminal,
  printDiagnostic,
  printResult,
  readPasswordFromStdin,
  type Terminal,
} from './diplomat/cli/terminal.js';
import { authErrors, type PasswordReset } from './models/auth.js';
import { ClaimOptionsSchema, ResetOptionsSchema, type ClaimOptions, type ResetOptions } from './wire/in/cli.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

/**
 * The CLI's composition root for the auth commands (ADR-034 §5): it opens the database exactly as the server does
 * — same key resolution, same bootstrap and migrations, so the owner row exists — but starts neither HTTP nor stdio.
 * Trust model: whoever can open the database with its key already controls the data, so these commands ask for no
 * code or current password; they are reachable only by a person at a terminal on this machine.
 */
export type AuthShell = {
  deps: AuthDeps;
  run: RunEffects;
  close: () => void;
};

/** Everything the commands do to the outside world, injected so they run against a test database and fake input. */
export type CliIo = {
  openShell: () => Promise<AuthShell>;
  /** A prompt on the user's terminal, or `null` when stdin is not one. */
  openTerminal: () => Terminal | null;
  readPasswordFromStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
};

const openAuthShell = async (): Promise<AuthShell> => {
  const db = await openDatabase(loadConfig());
  await bootstrap(db);
  const engineContext = createEngineContext(db);
  return {
    deps: await createAuthDeps(db),
    run: bindAuthRunEffects((flow) => runEffects(engineContext, AUTH_APPLIERS, flow)),
    close: () => closeDatabase(db),
  };
};

export const defaultCliIo = (): CliIo => ({
  openShell: openAuthShell,
  openTerminal: () => (isInteractive() ? openTerminal() : null),
  readPasswordFromStdin,
  out: printResult,
  err: printDiagnostic,
});

export const CLI_MESSAGES = {
  ownerClaimed: (username: string) =>
    `Owner claimed: "${username}". Log in to the dashboard (/ui) with this username and your password.`,
  alreadyClaimed: (username: string) => `FinTrack is already set up: the owner is "${username}".`,
  passwordReset: (reset: PasswordReset) => `Password reset for "${reset.username}".`,
  sessionsEnded: (count: number) => `Sessions ended: ${count}`,
  tokensRevoked: (count: number) => `Access tokens revoked: ${count}`,
  resetting: (username: string) => `Choose a new password for "${username}".`,
  failure: (reason: string) => `fintrack: ${reason}`,
} as const;

export const AUTH_HELP = `
Usage: npx @rafaelfcarneiro/fintrack auth <command>

Commands:
  setup            Choose the owner's username and password (once; claims the existing owner, never creates a user)
  reset-password   Choose a new password and end every session and access token of that user

Options:
  --username <name>  (setup) the owner's username — required with --password-stdin
  --user <name>      (reset-password) whose password; default: the owner
  --password-stdin   read the password from stdin instead of asking (scripted installs; stdin must not be a terminal)
`.trimStart();

const withShell = async <T>(io: CliIo, work: (shell: AuthShell) => Promise<T>): Promise<T> => {
  const shell = await io.openShell();
  try {
    return await work(shell);
  } finally {
    shell.close();
  }
};

/** The prompt sources for one command: the terminal is opened only when the password is not piped, and closed. */
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

export const fail = (io: CliIo, reason: string): false => {
  io.err(CLI_MESSAGES.failure(reason));
  return false;
};

/**
 * Claims the owner from the terminal if nobody holds its login yet (`auth setup`, and the first step of
 * `setup <client>`). `true` = the owner is claimed when this returns — by this call or before it — so the caller
 * may carry on; `false` = it is not, nothing was written, and the reason was reported.
 */
export const ensureOwnerClaimed = (io: CliIo, options: ClaimOptions): Promise<boolean> =>
  withShell(io, async (shell) => {
    const existing = await claimedOwnerOf(shell.deps);
    if (existing) {
      io.out(CLI_MESSAGES.alreadyClaimed(existing.username));
      return true;
    }

    const credentials = await withPromptIo(io, options, (promptIo) => collectNewCredentials(promptIo, options));
    if (credentials.isErr()) return fail(io, credentials.error);

    const claimed = await shell.run(() => claimOwnerLocally(shell.deps, credentials.value));
    if (claimed.isOk()) {
      io.out(CLI_MESSAGES.ownerClaimed(claimed.value.username));
      return true;
    }
    // Someone claimed it between the check above and the write: the end state is what the caller wanted.
    if (claimed.error.code === authErrors.setupUnavailable.code) {
      const winner = await claimedOwnerOf(shell.deps);
      if (winner) io.out(CLI_MESSAGES.alreadyClaimed(winner.username));
      return winner !== null;
    }
    return fail(io, formatAppError(claimed.error));
  });

const reportReset = (io: CliIo, reset: PasswordReset): void => {
  io.out(CLI_MESSAGES.passwordReset(reset));
  io.out(CLI_MESSAGES.sessionsEnded(reset.sessionsEnded));
  io.out(CLI_MESSAGES.tokensRevoked(reset.tokensRevoked));
};

const resetUserPassword = (io: CliIo, options: ResetOptions): Promise<boolean> =>
  withShell(io, async (shell) => {
    // Resolve the user before asking for anything: a typo'd `--user` should not cost a typed password.
    const target = await findResetTarget(shell.deps, options.user);
    if (target.isErr()) return fail(io, formatAppError(target.error));

    const password = await withPromptIo(io, options, (promptIo) => {
      promptIo.terminal?.tell(CLI_MESSAGES.resetting(target.value.username));
      return collectNewPassword(promptIo, options);
    });
    if (password.isErr()) return fail(io, password.error);

    const reset = await shell.run(() =>
      resetPassword(shell.deps, { username: options.user, password: password.value }),
    );
    if (reset.isErr()) return fail(io, formatAppError(reset.error));
    reportReset(io, reset.value);
    return true;
  });

const parseFlags = <T>(
  args: readonly string[],
  options: ParseArgsConfig['options'],
  schema: ZodType<T, ZodTypeDef, unknown>,
): { positionals: string[]; options: T } | { error: string } => {
  try {
    const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    const decoded = schema.safeParse(parsed.values);
    return decoded.success
      ? { positionals: parsed.positionals, options: decoded.data }
      : { error: decoded.error.issues[0]?.message ?? PROMPT_MESSAGES.invalidAnswer };
  } catch (cause) {
    // `parseArgs` rejects an unknown flag or a flag missing its value with a message fit to show.
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
};

const CLAIM_FLAGS = { 'password-stdin': { type: 'boolean' }, username: { type: 'string' } } as const;
const RESET_FLAGS = { 'password-stdin': { type: 'boolean' }, user: { type: 'string' } } as const;

/** `setup`'s and `auth setup`'s flags; `setup` also takes the client as its one positional. */
export const parseClaimArgs = (args: readonly string[]) => parseFlags(args, CLAIM_FLAGS, ClaimOptionsSchema);

export const exitCodeOf = (succeeded: boolean): number => (succeeded ? EXIT_OK : EXIT_FAILURE);

/** `fintrack auth <subcommand> …` — returns the process exit code. */
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
    const parsed = parseClaimArgs(rest);
    if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
    return exitCodeOf(await ensureOwnerClaimed(io, parsed.options));
  }
  const parsed = parseFlags(rest, RESET_FLAGS, ResetOptionsSchema);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  return exitCodeOf(await resetUserPassword(io, parsed.options));
};
