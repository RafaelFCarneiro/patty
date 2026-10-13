import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXIT_FAILURE } from '../../common/cli.js';
import type { ClientConfig, ClientConfigs } from '../../controllers/deps.js';
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
