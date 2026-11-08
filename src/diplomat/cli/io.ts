import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { Result, ResultAsync } from 'neverthrow';
import type { ZodType, ZodTypeDef } from 'zod';
import type { AuthDeps, ClientConfigs, RunEffects, SignInInterpreter } from '../../controllers/deps.js';
import { reasonOf } from '../../models/error.js';
import type { ExportedRowCounts } from '../../models/export.js';
import type { KeySources } from '../../models/key-import.js';
import { databaseAheadMessage, type DatabaseAhead } from '../../models/database.js';
import type { DemoFailure, DemoPrepared } from '../../models/demo/core.js';
import type { DemoOptions } from '../../wire/in/cli.js';
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
  /** The origin an invite link names: `PUBLIC_URL`. Null without one: the terminal prints the code and the page path,
   *  never a secret-bearing link to an address it cannot show serves this database. */
  inviteOrigin: string | null;
  /** Runs the sign-in protocol for a profile: its keychain entry, and the page `/ui/connect` is served from (the
   *  running server, else a temporary one) while a login waits. */
  signIn: (profile: string) => SignInInterpreter;
};

/**
 * What `key export` and `db export` need from the database and its key, and nothing else. The key never crosses this
 * port except as the value `provenKey` hands the one command that writes it where the person pointed. Neither method
 * migrates or seeds: an export must not upgrade a database as a side effect.
 */
export type Exporter = {
  /** The database file this process would open (`DB_PATH`). */
  databasePath: () => string;
  /** The key the database opens with — resolved as the server does — after opening it and reading once. The error
   *  says why it did not open; it never carries the key. */
  provenKey: () => Promise<Result<string, string>>;
  /** Writes a consistent, still-encrypted snapshot to `destination` (created here: new, owner-only) and counts the
   *  rows it holds. A failure leaves nothing at `destination`. */
  writeSnapshot: (destination: string) => Promise<Result<ExportedRowCounts, string>>;
};

/**
 * What `key import` and `db import` need, and nothing else — the mirror of `Exporter`. A key crosses this port only
 * inward (`storeKey`) or as the value `resolveKey` hands the one command that proves a snapshot with it; it is never
 * returned for printing. Neither method migrates or seeds: the next start does, with its usual safety copy.
 */
export type Importer = {
  databasePath: () => string;
  keySources: () => Promise<Result<KeySources, string>>;
  proveAgainstDatabase: (key: string) => Promise<Result<void, string>>;
  storeKey: (key: string) => Promise<Result<void, string>>;
  resolveKey: () => Promise<Result<string, string>>;
  inspectSnapshot: (snapshot: string, key: string) => Promise<Result<ExportedRowCounts, string>>;
  placeSnapshot: (snapshot: string) => Promise<Result<void, string>>;
};

export type DemoShell = {
  databasePath: string;
  hasDatabase: () => boolean;
  prepare: (request: DemoOptions) => Promise<Result<DemoPrepared, DemoFailure>>;
  serve: () => Promise<Result<void, DemoFailure>>;
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
  /** The database and its key, for the export commands. */
  exporter: Exporter;
  importer: Importer;
  demo: DemoShell;
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

/** An unknown subcommand of `group`: says so, prints that group's help, and fails. */
export const refuseUnknownSubcommand = (io: CliIo, group: string, name: string, help: string): number => {
  io.err(CLI_MESSAGES.failure(`unknown ${group} command "${name}"`));
  io.err(help);
  return EXIT_FAILURE;
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
