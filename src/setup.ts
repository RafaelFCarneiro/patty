import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared MCP entry shapes
// ---------------------------------------------------------------------------

const PACKAGE_SPEC = '@rafaelfcarneiro/fintrack@latest';

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
  process.exit(1);
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
    process.exit(1);
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

const setupClaudeCode = (): void => {
  const configPath = join(home, '.claude', 'mcp.json');
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), STDIO_ENTRY));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Verify with: claude mcp list');
};

const setupClaudeDesktop = (): void => {
  const configPath = claudeDesktopConfigPath();
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), STDIO_ENTRY));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Fully quit and reopen Claude Desktop to apply.');
};

const setupCopilot = (): void => {
  const configPath = join(process.cwd(), '.vscode', 'mcp.json');
  writeJson(configPath, mergeServersKey(readJsonOrEmpty(configPath), VSCODE_ENTRY));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Reload VS Code window (Cmd/Ctrl+Shift+P → "Developer: Reload Window") to apply.');
};

const setupAntigravity = (): void => {
  const configPath = join(home, '.gemini', 'config', 'mcp_config.json');
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), STDIO_ENTRY));
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`);
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Reopen Antigravity or type /mcp in the CLI to refresh.');
};

const setupCodex = (): void => {
  // Codex CLI MCP configuration path and format is not yet stable.
  // Print the snippet and let the user place it manually.
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Codex CLI: add the following to your MCP config file:

  {
    "mcpServers": {
      "fintrack": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_SPEC}"]
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
  readonly run: () => void;
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
Usage: npx ${PACKAGE_SPEC} setup <tool>

Available tools:
  claude-code      Claude Code CLI      (~/.claude/mcp.json)
  claude-desktop   Claude Desktop       (OS-specific config path)
  copilot          VS Code / GitHub Copilot    (.vscode/mcp.json in current directory)
  vscode           VS Code / GitHub Copilot    (alias for copilot)
  antigravity      Google Antigravity   (~/.gemini/config/mcp_config.json)
  codex            OpenAI Codex         (prints the config snippet to paste)

Examples:
  npx ${PACKAGE_SPEC} setup claude-code
  npx ${PACKAGE_SPEC} setup copilot
  npx ${PACKAGE_SPEC} setup vscode
  npx ${PACKAGE_SPEC} setup antigravity
`.trimStart();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const runSetup = (tool: string | undefined): void => {
  if (!tool) {
    // eslint-disable-next-line no-console -- CLI surface
    console.log(HELP);
    process.exit(0);
  }

  const client = TOOLS[tool.trim().toLowerCase()];
  if (!client) {
    console.error(`fintrack setup: unknown tool "${tool}"\n\nRun without arguments to see available tools.`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console -- CLI surface
  console.log(`Setting up FinTrack MCP for ${client.label}...`);
  client.run();
  // eslint-disable-next-line no-console -- CLI surface
  console.log('Done.');
};
