import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { ZodType, ZodTypeDef } from 'zod';
import { runEffects } from '@rfc0/effect-runner';
import { AUTH_APPLIERS, bindAuthRunEffects, createAuthDeps } from './authRuntime.js';
import { version } from './common/buildVersion.js';
import { formatAppError } from './common/errors.js';
import { AUTH_POSITIONALS, AuthSubcommand, EXIT_FAILURE, EXIT_OK, PASSWORD_STDIN_FLAG } from './common/cli.js';
import { loadConfig } from './config.js';
import { dbIdOf, keychainAccount } from './logic/auth/keychain.js';
import { claimRaceWinner, planOwnerClaim } from './logic/auth/owner.js';
import { claimedOwnerOf, claimOwnerLocally, findResetTarget, resetPassword } from './controllers/auth.js';
import type { AuthDeps, RunEffects, SignInServer, SignInStore } from './controllers/deps.js';
import { bootstrap } from './diplomat/db/bootstrap.js';
import { closeDatabase, openDatabase } from './diplomat/db/driver.js';
import { createEngineContext } from './diplomat/db/engine.js';
import { collectNewCredentials, collectNewPassword, PROMPT_MESSAGES, type PromptIo } from './diplomat/cli/prompt.js';
import * as tty from './diplomat/cli/terminal.js';
import { keychainSignInStore } from './diplomat/auth/signInStore.js';
import { AuthMode } from './models/auth/mode.js';
import { type PasswordReset } from './models/auth/password.js';
import { NPX_COMMAND } from './models/package.js';
import { ClaimOptionsSchema, ResetOptionsSchema, type ClaimOptions, type ResetOptions } from './wire/in/cli.js';

/**
 * Opens the database as the server does (same key, bootstrap and migrations) but starts neither HTTP nor stdio.
 * Trust model: whoever can open the database with its key already controls the data, so these commands ask for no
 * code or current password.
 */
export type Shell = {
  deps: AuthDeps;
  run: RunEffects;
  close: () => void;
  /** `false` under an explicit `FINTRACK_AUTH=disabled`: stdio acts as the owner, so there is nothing to sign in to. */
  authRequired: boolean;
  /** `FINTRACK_PROFILE` — the profile `login`/`logout` act on unless `--profile` says otherwise. */
  defaultProfile: string;
  /** The keychain entry of a profile's saved sign-in, for this database. */
  store: (profile: string) => SignInStore;
  /** Where `/ui/connect` is served while a login waits: the running server, else a temporary one. */
  startServer: () => Promise<SignInServer>;
};

export type CliIo = {
  openShell: () => Promise<Shell>;
  openTerminal: () => tty.Terminal | null;
  readPasswordFromStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** This build's version, reported to the approver as the requesting client's. */
  version: string;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborts on Ctrl-C. Installed only when asked for, so commands that do not wait keep the default behavior. */
  interruptSignal: () => AbortSignal;
};

/** Lazy: only `login` serves a page, so the other commands never load the server composition. */
const loadSignInServerModule = () => import('./signInServer.js');

const openShell = async (): Promise<Shell> => {
  const config = loadConfig();
  const db = await openDatabase(config);
  try {
    await bootstrap(db);
  } catch (cause) {
    closeDatabase(db);
    throw cause;
  }
  const engineContext = createEngineContext(db);
  const deps = await createAuthDeps(db);
  const dbId = dbIdOf(deps.secrets.hashSecret(config.DB_PATH));
  return {
    deps,
    run: bindAuthRunEffects((flow) => runEffects(engineContext, AUTH_APPLIERS, flow)),
    close: () => closeDatabase(db),
    authRequired: config.FINTRACK_AUTH === AuthMode.enum.required,
    defaultProfile: config.FINTRACK_PROFILE,
    store: (profile) => keychainSignInStore(keychainAccount(profile, dbId)),
    startServer: async () => (await loadSignInServerModule()).startSignInServer(config, db),
  };
};

const waitOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });

const interruptSignal = (): AbortSignal => {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  return controller.signal;
};

export const defaultCliIo = (): CliIo => ({
  openShell,
  openTerminal: () => (tty.isInteractive() ? tty.open() : null),
  readPasswordFromStdin: tty.readPasswordFromStdin,
  out: tty.printResult,
  err: tty.printDiagnostic,
  version,
  wait: waitOrAbort,
  interruptSignal,
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
  unexpectedArgument: (argument: string) => `unexpected argument "${argument}"`,
} as const;

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

export const withShell = async <T>(io: CliIo, work: (shell: Shell) => Promise<T>): Promise<T> => {
  const shell = await io.openShell();
  try {
    return await work(shell);
  } finally {
    shell.close();
  }
};

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

/** `true` = the owner holds a login when this returns (claimed now or before); `false` = nothing was written. */
export const ensureOwnerClaimed = (io: CliIo, options: ClaimOptions): Promise<boolean> =>
  withShell(io, async (shell) => {
    const plan = planOwnerClaim(await claimedOwnerOf(shell.deps));
    if (plan.kind === 'skip') {
      io.out(CLI_MESSAGES.alreadyClaimed(plan.username));
      return true;
    }

    const credentials = await withPromptIo(io, options, (promptIo) => collectNewCredentials(promptIo, options));
    if (credentials.isErr()) return fail(io, credentials.error);

    const claimed = await shell.run(() => claimOwnerLocally(shell.deps, credentials.value));
    if (claimed.isOk()) {
      io.out(CLI_MESSAGES.ownerClaimed(claimed.value.username));
      return true;
    }
    const winner = claimRaceWinner(claimed.error, await claimedOwnerOf(shell.deps));
    if (winner) {
      io.out(CLI_MESSAGES.alreadyClaimed(winner.username));
      return true;
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

export const parseFlags = <T>(
  args: readonly string[],
  options: ParseArgsConfig['options'],
  schema: ZodType<T, ZodTypeDef, unknown>,
  maxPositionals: number,
): { positionals: string[]; options: T } | { error: string } => {
  try {
    const parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    const extra = parsed.positionals[maxPositionals];
    if (extra !== undefined) return { error: CLI_MESSAGES.unexpectedArgument(extra) };
    const decoded = schema.safeParse(parsed.values);
    return decoded.success
      ? { positionals: parsed.positionals, options: decoded.data }
      : { error: decoded.error.issues[0]?.message ?? PROMPT_MESSAGES.invalidAnswer };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
};

const CLAIM_FLAGS = { [PASSWORD_STDIN_FLAG]: { type: 'boolean' }, username: { type: 'string' } } as const;
const RESET_FLAGS = { [PASSWORD_STDIN_FLAG]: { type: 'boolean' }, user: { type: 'string' } } as const;

export const parseClaimArgs = (args: readonly string[], maxPositionals: number) =>
  parseFlags(args, CLAIM_FLAGS, ClaimOptionsSchema, maxPositionals);

export const exitCodeOf = (succeeded: boolean): number => (succeeded ? EXIT_OK : EXIT_FAILURE);

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
    return exitCodeOf(await ensureOwnerClaimed(io, parsed.options));
  }
  const parsed = parseFlags(rest, RESET_FLAGS, ResetOptionsSchema, AUTH_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  return exitCodeOf(await resetUserPassword(io, parsed.options));
};
