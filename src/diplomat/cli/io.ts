import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { ZodType, ZodTypeDef } from 'zod';
import { EXIT_FAILURE, EXIT_OK } from '../../common/cli.js';
import type { AuthDeps, ClientConfigs, RunEffects, SignInInterpreter } from '../../controllers/deps.js';
import { CLI_MESSAGES } from './messages.js';
import { PROMPT_MESSAGES } from './prompt.js';
import type { Terminal } from './terminal.js';

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
  /** Runs the sign-in protocol for a profile: its keychain entry, and the page `/ui/connect` is served from (the
   *  running server, else a temporary one) while a login waits. */
  signIn: (profile: string) => SignInInterpreter;
};

export type CliIo = {
  openShell: () => Promise<Shell>;
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

export const withShell = async <T>(io: CliIo, work: (shell: Shell) => Promise<T>): Promise<T> => {
  const shell = await io.openShell();
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
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
};
