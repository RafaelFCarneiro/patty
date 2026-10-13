import { ClientConfigError } from '../../../common/clientConfig.js';
import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../../models/auth/signIn.js';
import { NPX_COMMAND } from '../../../models/package.js';
import { PASSWORD_STDIN_FLAG, SETUP_POSITIONALS, SetupOptionsSchema } from '../../../wire/in/cli.js';
import { EXIT_FAILURE, EXIT_OK, exitCodeOf, fail, parseFlags, type CliIo } from '../io.js';
import { ensureOwnerClaimed } from './auth.js';
import { offerSignIn } from './login.js';

const SETUP_FLAGS = {
  [PASSWORD_STDIN_FLAG]: { type: 'boolean' },
  username: { type: 'string' },
  profile: { type: 'string' },
} as const;

const HELP = `
Usage: ${NPX_COMMAND} setup <tool> [--username <name>] [--${PASSWORD_STDIN_FLAG}] [--profile <name>]

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

Examples:
  ${NPX_COMMAND} setup claude-code
  ${NPX_COMMAND} setup copilot
  ${NPX_COMMAND} setup vscode
  ${NPX_COMMAND} setup antigravity
`.trimStart();

/** What `setup` needs of the I/O: where to print, and the client config files. */
type SetupIo = Pick<CliIo, 'out' | 'err' | 'clients'>;

/** Writes the client's configuration and answers the exit code: help is `EXIT_OK`, an unknown tool or a configuration
 *  file that cannot be read or written is reported on stderr and is `EXIT_FAILURE`. */
export const runSetup = (io: SetupIo, tool: string | undefined, profile: string = DEFAULT_PROFILE): number => {
  if (!tool) {
    io.out(HELP);
    return EXIT_OK;
  }

  const client = io.clients.find(tool);
  if (!client) {
    io.err(`fintrack setup: unknown tool "${tool}"\n\nRun without arguments to see available tools.`);
    return EXIT_FAILURE;
  }

  io.out(`Setting up FinTrack MCP for ${client.label}...`);
  try {
    client.run(profile);
  } catch (cause) {
    if (!(cause instanceof ClientConfigError)) throw cause;
    io.err(cause.message);
    return EXIT_FAILURE;
  }
  io.out('Done.');
  return EXIT_OK;
};

/** Claims the owner first, writes the client config only if that succeeded, then offers to sign the client in
 *  (ADR-034 §5.3). Help and an unknown tool never claim. */
export const runGuidedSetup = async (
  io: SetupIo,
  tool: string | undefined,
  claimOwner: () => Promise<boolean>,
  signIn: (profile: string) => Promise<void> = async () => undefined,
  profile: string = DEFAULT_PROFILE,
): Promise<number> => {
  if (!tool || io.clients.find(tool) === undefined) return runSetup(io, tool, profile);
  if (!(await claimOwner())) return EXIT_FAILURE;
  const written = runSetup(io, tool, profile);
  if (written !== EXIT_OK) return written;
  await signIn(profile);
  return EXIT_OK;
};

export const runSetupCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const parsed = parseFlags(args, SETUP_FLAGS, SetupOptionsSchema, SETUP_POSITIONALS);
  if ('error' in parsed) return exitCodeOf(fail(io, parsed.error));
  const [client] = parsed.positionals;
  return runGuidedSetup(
    io,
    client,
    () => ensureOwnerClaimed(io, parsed.options),
    (profile) => offerSignIn(io, profile),
    parsed.options.profile,
  );
};
