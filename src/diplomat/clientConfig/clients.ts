import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClientConfigError } from '../../common/clientConfig.js';
import type { ClientConfig, ClientConfigs, ClientSetupReport } from '../../controllers/deps.js';
import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../models/auth/signIn.js';
import { PACKAGE_SPEC } from '../../models/package.js';
import {
  mergeMcpServersKey,
  mergeServersKey,
  resolveConfigObject,
  STDIO_ENTRY,
  VSCODE_ENTRY,
  withProfile,
} from './merge.js';

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

const INVALID_ROOT_MESSAGE = 'does not contain a JSON object at the root';

const invalidConfigWarning = (path: string): string =>
  `fintrack setup: ${path} ${INVALID_ROOT_MESSAGE} — replacing it during setup.`;

const failedToRead = (path: string, error: unknown): ClientConfigError =>
  new ClientConfigError(
    `fintrack setup: failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
  );

/** The config object in the file — `{}` for a missing, empty or unusable one, the last with a warning. */
export const readJsonOrEmpty = (path: string): { config: Record<string, unknown>; warnings: string[] } => {
  if (!existsSync(path)) return { config: {}, warnings: [] };

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    throw failedToRead(path, error);
  }

  try {
    const trimmedContent = content.trim();
    if (!trimmedContent) return { config: {}, warnings: [] };

    const config = resolveConfigObject(JSON.parse(trimmedContent));
    if (config) return { config, warnings: [] };
    return { config: {}, warnings: [invalidConfigWarning(path)] };
  } catch {
    return { config: {}, warnings: [invalidConfigWarning(path)] };
  }
};

const writeJson = (path: string, data: unknown): void => {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ClientConfigError(`fintrack setup: failed to write ${path}: ${message}`);
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

/** Reads the client's file, merges the FinTrack entry in, writes it back, and reports. */
const writeEntry = (
  configPath: string,
  merge: (existing: Record<string, unknown>, entry: Record<string, unknown>) => Record<string, unknown>,
  entry: Record<string, unknown>,
  next: string,
): ClientSetupReport => {
  const { config, warnings } = readJsonOrEmpty(configPath);
  try {
    writeJson(configPath, merge(config, entry));
  } catch (cause) {
    // What was raised while reading is still owed to the person, ahead of the failure.
    throw cause instanceof ClientConfigError ? new ClientConfigError(cause.message, warnings) : cause;
  }
  return { warnings, lines: [`  Updated: ${configPath}`, next] };
};

const setupClaudeCode = (profile: string): ClientSetupReport =>
  writeEntry(
    join(home, '.claude', 'mcp.json'),
    mergeMcpServersKey,
    withProfile(STDIO_ENTRY, profile),
    '  Verify with: claude mcp list',
  );

const setupClaudeDesktop = (profile: string): ClientSetupReport =>
  writeEntry(
    claudeDesktopConfigPath(),
    mergeMcpServersKey,
    withProfile(STDIO_ENTRY, profile),
    '  Fully quit and reopen Claude Desktop to apply.',
  );

const setupCopilot = (profile: string): ClientSetupReport =>
  writeEntry(
    join(process.cwd(), '.vscode', 'mcp.json'),
    mergeServersKey,
    withProfile(VSCODE_ENTRY, profile),
    '  Reload VS Code window (Cmd/Ctrl+Shift+P → "Developer: Reload Window") to apply.',
  );

const setupAntigravity = (profile: string): ClientSetupReport =>
  writeEntry(
    join(home, '.gemini', 'config', 'mcp_config.json'),
    mergeMcpServersKey,
    withProfile(STDIO_ENTRY, profile),
    '  Reopen Antigravity or type /mcp in the CLI to refresh.',
  );

// Codex CLI MCP configuration path and format is not yet stable: describe the snippet and let the user place it.
const setupCodex = (profile: string): ClientSetupReport => ({
  warnings: [],
  lines: [
    `  Codex CLI: add the following to your MCP config file:

  {
    "mcpServers": {
      "fintrack": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_SPEC}"]${profile === DEFAULT_PROFILE ? '' : `,\n        "env": { "${PROFILE_ENV_VAR}": "${profile}" }`}
      }
    }
  }

  Refer to the Codex CLI docs for the exact config file location.`,
  ],
});

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

const TOOLS: Readonly<Record<string, ClientConfig>> = {
  'claude-code': { label: 'Claude Code (CLI)', run: setupClaudeCode },
  'claude-desktop': { label: 'Claude Desktop', run: setupClaudeDesktop },
  copilot: { label: 'VS Code / GitHub Copilot', run: setupCopilot },
  vscode: { label: 'VS Code / GitHub Copilot', run: setupCopilot },
  antigravity: { label: 'Google Antigravity', run: setupAntigravity },
  codex: { label: 'OpenAI Codex', run: setupCodex },
};

const findClient = (tool: string): ClientConfig | undefined => TOOLS[tool.trim().toLowerCase()];

export const clientConfigs: ClientConfigs = { find: findClient };
