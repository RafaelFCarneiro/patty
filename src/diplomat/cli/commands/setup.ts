import { ClientConfigFailureCode, type ClientConfigFailure } from '../../../models/client-config.js';
import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../../models/auth/sign-in.js';
import { DEMO_SERVER_NAME } from '../../../models/demo.js';
import { NPX_COMMAND } from '../../../models/package.js';
import {
  DEMO_FLAG,
  DemoEntryChange,
  PASSWORD_STDIN_FLAG,
  REMOVE_DEMO_FLAG,
  SETUP_POSITIONALS,
  SetupOptionsSchema,
} from '../../../wire/in/cli.js';
import { EXIT_FAILURE, EXIT_OK, exitCodeOf, fail, parseFlags, type CliIo } from '../io.js';
import { ensureOwnerClaimed } from './auth.js';
import { offerSignIn } from './login.js';

const SETUP_FLAGS = {
  [PASSWORD_STDIN_FLAG]: { type: 'boolean' },
  username: { type: 'string' },
  profile: { type: 'string' },
  [DEMO_FLAG]: { type: 'boolean' },
  [REMOVE_DEMO_FLAG]: { type: 'boolean' },
} as const;

const CONFIG_FAILURE_VERB: Readonly<Record<ClientConfigFailureCode, string>> = {
  [ClientConfigFailureCode.enum.read_failed]: 'read',
  [ClientConfigFailureCode.enum.write_failed]: 'write',
};

/** What `setup` says. The help text is also printed for `fintrack setup` with no tool. */
export const SETUP_MESSAGES = {
  help: `
Usage: ${NPX_COMMAND} setup <tool> [--username <name>] [--${PASSWORD_STDIN_FLAG}] [--profile <name>]
       ${NPX_COMMAND} setup <tool> --${DEMO_FLAG} | --${REMOVE_DEMO_FLAG}

Available tools:
  claude-code      Claude Code CLI      (~/.claude/mcp.json)
  claude-desktop   Claude Desktop       (OS-specific config path)
  copilot          VS Code / GitHub Copilot    (.vscode/mcp.json in current directory)
  vscode           VS Code / GitHub Copilot    (alias for copilot)
  antigravity      Google Antigravity   (~/.gemini/config/mcp_config.json)
  codex            OpenAI Codex         (prints the config snippet to paste)

FinTrack requires a login. The first time, setup asks you to choose the owner's username and password
(typed twice, never echoed), writes the client's config, then offers to sign that client in. Re-running it is safe: an
owner that already has a login is left alone.

Options:
  --username <name>  the owner's username (required with --${PASSWORD_STDIN_FLAG})
  --${PASSWORD_STDIN_FLAG}   read the password from stdin instead of asking — for scripted installs
  --profile <name>   sign this client in as a separate profile (adds ${PROFILE_ENV_VAR} to its config); default: ${DEFAULT_PROFILE}
  --${DEMO_FLAG}           add a second MCP entry, ${DEMO_SERVER_NAME}, that runs on the demo database (see: ${NPX_COMMAND} demo);
                     the fintrack entry is never touched, and no login is needed
  --${REMOVE_DEMO_FLAG}    remove only the ${DEMO_SERVER_NAME} entry

Examples:
  ${NPX_COMMAND} setup claude-code
  ${NPX_COMMAND} setup copilot
  ${NPX_COMMAND} setup vscode
  ${NPX_COMMAND} setup antigravity
`.trimStart(),
  unknownTool: (tool: string) =>
    `fintrack setup: unknown tool "${tool}"\n\nRun without arguments to see available tools.`,
  settingUp: (label: string) => `Setting up FinTrack MCP for ${label}...`,
  settingUpDemo: (change: DemoEntryChange, label: string) =>
    `${change === DemoEntryChange.enum.add ? 'Adding' : 'Removing'} the ${DEMO_SERVER_NAME} MCP entry for ${label}...`,
  demoNext: `  Create or refresh its data with: ${NPX_COMMAND} demo — the ${DEMO_SERVER_NAME} server only opens a seeded demo database.`,
  done: 'Done.',
  /** Said when a client's configuration file could not be used: the same words whichever file it was. */
  configFailure: (failure: ClientConfigFailure) =>
    `fintrack setup: failed to ${CONFIG_FAILURE_VERB[failure.code]} ${failure.path}: ${failure.reason}`,
} as const;

/** What `setup` needs of the I/O: where to print, and the client config files. */
type SetupIo = Pick<CliIo, 'out' | 'err' | 'clients'>;

/** Writes the client's configuration and answers the exit code: help is `EXIT_OK`, an unknown tool or a configuration
 *  file that cannot be read or written is reported on stderr and is `EXIT_FAILURE`. */
export const runSetup = (io: SetupIo, tool: string | undefined, profile: string = DEFAULT_PROFILE): number => {
  if (!tool) {
    io.out(SETUP_MESSAGES.help);
    return EXIT_OK;
  }

  const client = io.clients.find(tool);
  if (!client) {
    io.err(SETUP_MESSAGES.unknownTool(tool));
    return EXIT_FAILURE;
  }

  io.out(SETUP_MESSAGES.settingUp(client.label));
  return client.run(profile).match(
    (report) => {
      report.warnings.forEach((warning) => io.err(warning));
      report.lines.forEach((line) => io.out(line));
      io.out(SETUP_MESSAGES.done);
      return EXIT_OK;
    },
    (failure) => {
      failure.warnings.forEach((warning) => io.err(warning));
      io.err(SETUP_MESSAGES.configFailure(failure));
      return EXIT_FAILURE;
    },
  );
};

/** Claims the owner first, writes the client config only if that succeeded, then offers to sign the client in
 *  (ADR-034 §5.3). Help and an unknown tool never claim. `claimOwner` and `signIn` answer the exit code to end with
 *  (`EXIT_OK` to go on). */
export const runGuidedSetup = async (
  io: SetupIo,
  tool: string | undefined,
  claimOwner: () => Promise<number>,
  signIn: (profile: string) => Promise<number | undefined> = async () => undefined,
  profile: string = DEFAULT_PROFILE,
): Promise<number> => {
  if (!tool || io.clients.find(tool) === undefined) return runSetup(io, tool, profile);
  const claimed = await claimOwner();
  if (claimed !== EXIT_OK) return claimed;
  const written = runSetup(io, tool, profile);
  if (written !== EXIT_OK) return written;
  return (await signIn(profile)) ?? EXIT_OK;
};

/** `--demo` / `--remove-demo`: edits only the client's `fintrack-demo` entry. It claims no owner and signs nothing in —
 *  the demo has no login — and never opens a database. */
export const runDemoEntry = (io: SetupIo, tool: string | undefined, change: DemoEntryChange): number => {
  if (!tool) {
    io.out(SETUP_MESSAGES.help);
    return EXIT_OK;
  }
  const client = io.clients.find(tool);
  if (!client) {
    io.err(SETUP_MESSAGES.unknownTool(tool));
    return EXIT_FAILURE;
  }
  io.out(SETUP_MESSAGES.settingUpDemo(change, client.label));
  return (change === DemoEntryChange.enum.add ? client.addDemo() : client.removeDemo()).match(
    (report) => {
      report.warnings.forEach((warning) => io.err(warning));
      report.lines.forEach((line) => io.out(line));
      if (change === DemoEntryChange.enum.add) io.out(SETUP_MESSAGES.demoNext);
      io.out(SETUP_MESSAGES.done);
      return EXIT_OK;
    },
    (failure) => {
      failure.warnings.forEach((warning) => io.err(warning));
      io.err(SETUP_MESSAGES.configFailure(failure));
      return EXIT_FAILURE;
    },
  );
};

export const runSetupCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, SETUP_FLAGS, SetupOptionsSchema, SETUP_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const [client] = parsed.positionals;
  if (parsed.options.demo) return runDemoEntry(io, client, DemoEntryChange.enum.add);
  if (parsed.options.removeDemo) return runDemoEntry(io, client, DemoEntryChange.enum.remove);
  return runGuidedSetup(
    io,
    client,
    () => ensureOwnerClaimed(io, parsed.options),
    (profile) => offerSignIn(io, profile),
    parsed.options.profile,
  );
};
