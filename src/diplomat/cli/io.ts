import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { ResultAsync } from 'neverthrow';
import type { ZodType, ZodTypeDef } from 'zod';
import type { AuthDeps, ClientConfigs, RunEffects, SignInInterpreter } from '../../controllers/deps.js';
import { reasonOf } from '../../models/error.js';
import { databaseAheadMessage, type DatabaseAhead } from '../../models/database.js';
import { CLI_MESSAGES } from './messages.js';
import { isPromptEnded, PROMPT_MESSAGES, type PromptFailure } from './prompt.js';
import { PROMPT_ABORTED_MESSAGE, PromptEnd, type Terminal } from './terminal.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
/** The conventional status of a process stopped by Ctrl-C (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

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
  /** The origin an invite link names: `PUBLIC_URL`, else where this install serves its dashboard. */
  inviteOrigin: string;
  /** Runs the sign-in protocol for a profile: its keychain entry, and the page `/ui/connect` is served from (the
   *  running server, else a temporary one) while a login waits. */
  signIn: (profile: string) => SignInInterpreter;
};

export type CliIo = {
  /** The database, opened and migrated — or why it cannot be used (a build older than the database). */
  openShell: () => ResultAsync<Shell, DatabaseAhead>;
  openTerminal: () => Terminal | null;
  readPasswordFromStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** This build's version, reported to the approver as the requesting client's. */
  version: string;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborts on Ctrl-C. Installed only when asked for, so commands that do not wait keep the default behavior. */
  interruptSignal: () => AbortSignal;
  /** The MCP clients `setup` can write a configuration for. */
  clients: ClientConfigs;
};

/** Runs `work` on the opened shell and closes it. When the database is newer than this build, says so on stderr
 *  (the one wording, `databaseAheadMessage`) and answers `whenUnavailable` without running anything. */
export const withShell = async <T>(io: CliIo, work: (shell: Shell) => Promise<T>, whenUnavailable: T): Promise<T> => {
  const opened = await io.openShell();
  if (opened.isErr()) {
    io.err(databaseAheadMessage(opened.error.version));
    return whenUnavailable;
  }
  const shell = opened.value;
  try {
    return await work(shell);
  } finally {
    shell.close();
  }
};

export const fail = (io: CliIo, reason: string): false => {
  io.err(CLI_MESSAGES.failure(reason));
  return false;
};

/** Says why on stderr and answers the failing exit code. */
export const failed = (io: CliIo, reason: string): number => exitCodeOf(fail(io, reason));

/** What a failed prompt answers: an invalid answer is a failure with its message; Ctrl-C is the interrupted exit
 *  (the terminal has already said its newline); Ctrl-D reads as "cancelled", a failure. */
export const exitCodeOfPrompt = (io: CliIo, failure: PromptFailure): number => {
  if (!isPromptEnded(failure)) return failed(io, failure.message);
  return failure.how === PromptEnd.enum.interrupted ? EXIT_INTERRUPTED : failed(io, PROMPT_ABORTED_MESSAGE);
};

export const exitCodeOf = (succeeded: boolean): number => (succeeded ? EXIT_OK : EXIT_FAILURE);

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
    return { error: reasonOf(cause) };
  }
};
