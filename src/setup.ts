import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXIT_FAILURE, EXIT_OK, PASSWORD_STDIN_FLAG } from './common/cli.js';
import { DEFAULT_PROFILE, NPX_COMMAND, PACKAGE_SPEC, PROFILE_ENV_VAR } from './models/auth.js';

// ---------------------------------------------------------------------------
// Shared MCP entry shapes
// ---------------------------------------------------------------------------

export const resolveConfigObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const STDIO_ENTRY = {
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

export const VSCODE_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', PACKAGE_SPEC],
} as const;

/** A client config entry that signs in as `profile`: `FINTRACK_PROFILE` is added to its `env` only when the profile
 *  is not the default, so an ordinary install writes exactly the entry it always did (ADR-034 §5.2). */
export const withProfile = <E extends Record<string, unknown>>(
  entry: E,
  profile: string,
): E | (E & { env: Record<string, string> }) =>
  profile === DEFAULT_PROFILE ? entry : { ...entry, env: { [PROFILE_ENV_VAR]: profile } };

// ---------------------------------------------------------------------------
// Pure config merge helpers (testable without FS)
// ---------------------------------------------------------------------------

/** Merges `{ mcpServers: { fintrack: entry } }` into an existing config object. */
export const mergeMcpServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const servers = resolveConfigObject(existing['mcpServers']) ?? {};
  return { ...existing, mcpServers: { ...servers, fintrack: entry } };
};

/** Merges `{ servers: { fintrack: entry } }` into an existing config object (VS Code shape). */
export const mergeServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const servers = resolveConfigObject(existing['servers']) ?? {};
  return { ...existing, servers: { ...servers, fintrack: entry } };
};

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

const INVALID_ROOT_MESSAGE = 'does not contain a JSON object at the root';

const warnInvalidConfig = (path: string): void => {
  console.error(`fintrack setup: ${path} ${INVALID_ROOT_MESSAGE} — replacing it during setup.`);
};

const exitReadConfig = (path: string, error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`fintrack setup: failed to read ${path}: ${message}`);
  process.exit(EXIT_FAILURE);
};

export const readJsonOrEmpty = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    return exitReadConfig(path, error);
  }

  try {
    const trimmedContent = content.trim();
    if (!trimmedContent) return {};

    const config = resolveConfigObject(JSON.parse(trimmedContent));
    if (config) return config;
    warnInvalidConfig(path);
    return {};
  } catch {
    warnInvalidConfig(path);
    return {};
  }
};

const writeJson = (path: string, data: unknown): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fintrack setup: failed to write ${path}: ${message}`);
    process.exit(EXIT_FAILURE);
  }
};

// ---------------------------------------------------------------------------
// Platform-aware config path helpers
// ---------------------------------------------------------------------------

const home = homedir();

const claudeDesktopConfigPath = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
};

// ---------------------------------------------------------------------------
// Per-client setup handlers
// ---------------------------------------------------------------------------

const setupClaudeCode = (profile: string): void => {
  const configPath = join(home, '.claude', 'mcp.json');
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), withProfile(STDIO_ENTRY, profile)));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Verify with: claude mcp list');
};

const setupClaudeDesktop = (profile: string): void => {
  const configPath = claudeDesktopConfigPath();
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), withProfile(STDIO_ENTRY, profile)));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Fully quit and reopen Claude Desktop to apply.');
};

const setupCopilot = (profile: string): void => {
  const configPath = join(process.cwd(), '.vscode', 'mcp.json');
  writeJson(configPath, mergeServersKey(readJsonOrEmpty(configPath), withProfile(VSCODE_ENTRY, profile)));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Reload VS Code window (Cmd/Ctrl+Shift+P → "Developer: Reload Window") to apply.');
};

const setupAntigravity = (profile: string): void => {
  const configPath = join(home, '.gemini', 'config', 'mcp_config.json');
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), withProfile(STDIO_ENTRY, profile)));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Reopen Antigravity or type /mcp in the CLI to refresh.');
};

const setupCodex = (profile: string): void => {
  // Codex CLI MCP configuration path and format is not yet stable.
  // Print the snippet and let the user place it manually.
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Codex CLI: add the following to your MCP config file:

  {
    "mcpServers": {
      "fintrack": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_SPEC}"]${profile === DEFAULT_PROFILE ? '' : `,\n        "env": { "${PROFILE_ENV_VAR}": "${profile}" }`}
      }
    }
  }

  Refer to the Codex CLI docs for the exact config file location.`);
};

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ClientTool {
  readonly label: string;
  readonly run: (profile: string) => void;
}

const TOOLS: Readonly<Record<string, ClientTool>> = {
  'claude-code': { label: 'Claude Code (CLI)', run: setupClaudeCode },
  'claude-desktop': { label: 'Claude Desktop', run: setupClaudeDesktop },
  copilot: { label: 'VS Code / GitHub Copilot', run: setupCopilot },
  vscode: { label: 'VS Code / GitHub Copilot', run: setupCopilot },
  antigravity: { label: 'Google Antigravity', run: setupAntigravity },
  codex: { label: 'OpenAI Codex', run: setupCodex },
};

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

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const findClient = (tool: string): ClientTool | undefined => TOOLS[tool.trim().toLowerCase()];

export const runSetup = (tool: string | undefined, profile: string = DEFAULT_PROFILE): void => {
  if (!tool) {
    // eslint-disable-next-line no-console -- CLI surface
    console.log(HELP);
    process.exit(EXIT_OK);
  }

  const client = findClient(tool);
  if (!client) {
    console.error(`fintrack setup: unknown tool "${tool}"\n\nRun without arguments to see available tools.`);
    process.exit(EXIT_FAILURE);
  }

  // eslint-disable-next-line no-console -- CLI surface
  console.log(`Setting up FinTrack MCP for ${client.label}...`);
  client.run(profile);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('Done.');
};

/** Claims the owner first, writes the client config only if that succeeded, then offers to sign the client in
 *  (ADR-034 §5.3). Help and an unknown tool never claim. */
export const runGuidedSetup = async (
  tool: string | undefined,
  claimOwner: () => Promise<boolean>,
  signIn: (profile: string) => Promise<void> = async () => undefined,
  profile: string = DEFAULT_PROFILE,
): Promise<number> => {
  if (!tool || findClient(tool) === undefined) {
    runSetup(tool, profile);
    return EXIT_OK;
  }
  if (!(await claimOwner())) return EXIT_FAILURE;
  runSetup(tool, profile);
  await signIn(profile);
  return EXIT_OK;
};
