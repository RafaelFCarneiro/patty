import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ok, Result } from 'neverthrow';
import type { ClientConfig, ClientConfigs, ClientSetupReport } from '../../controllers/deps.js';
import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../models/auth/signIn.js';
import { clientConfigFailures, type ClientConfigFailure } from '../../models/clientConfig.js';
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

const asCause = (cause: unknown): unknown => cause;

// The throwing system calls, wrapped once: everything below this block is Results.
const readText = Result.fromThrowable((path: string) => readFileSync(path, 'utf8'), asCause);
const writeText = Result.fromThrowable((path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}, asCause);
const parseJson = Result.fromThrowable((text: string): unknown => JSON.parse(text), asCause);

type ConfigRead = { config: Record<string, unknown>; warnings: string[] };

/** The config object in the file — `{}` for a missing, empty or unusable one, the last with a warning. */
export const readJsonOrEmpty = (path: string): Result<ConfigRead, ClientConfigFailure> => {
  if (!existsSync(path)) return ok({ config: {}, warnings: [] });
  return readText(path)
    .mapErr((cause) => clientConfigFailures.readFailed(path, cause))
    .map((content): ConfigRead => {
      const trimmed = content.trim();
      if (!trimmed) return { config: {}, warnings: [] };
      const config = parseJson(trimmed).map(resolveConfigObject).unwrapOr(null);
      return config ? { config, warnings: [] } : { config: {}, warnings: [invalidConfigWarning(path)] };
    });
};

const writeJson = (path: string, data: unknown): Result<void, ClientConfigFailure> =>
  writeText(path, JSON.stringify(data, null, 2) + '\n').mapErr((cause) =>
    clientConfigFailures.writeFailed(path, cause),
  );

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
): Result<ClientSetupReport, ClientConfigFailure> =>
  readJsonOrEmpty(configPath).andThen(({ config, warnings }) =>
    writeJson(configPath, merge(config, entry))
      .map((): ClientSetupReport => ({ warnings, lines: [`  Updated: ${configPath}`, next] }))
      // What was raised while reading is still owed to the person, ahead of the failure.
      .mapErr((failure) => ({ ...failure, warnings })),
  );

const setupClaudeCode = (profile: string): Result<ClientSetupReport, ClientConfigFailure> =>
  writeEntry(
    join(home, '.claude', 'mcp.json'),
    mergeMcpServersKey,
    withProfile(STDIO_ENTRY, profile),
    '  Verify with: claude mcp list',
  );

const setupClaudeDesktop = (profile: string): Result<ClientSetupReport, ClientConfigFailure> =>
  writeEntry(
    claudeDesktopConfigPath(),
    mergeMcpServersKey,
    withProfile(STDIO_ENTRY, profile),
    '  Fully quit and reopen Claude Desktop to apply.',
  );

const setupCopilot = (profile: string): Result<ClientSetupReport, ClientConfigFailure> =>
  writeEntry(
    join(process.cwd(), '.vscode', 'mcp.json'),
    mergeServersKey,
    withProfile(VSCODE_ENTRY, profile),
    '  Reload VS Code window (Cmd/Ctrl+Shift+P → "Developer: Reload Window") to apply.',
  );

const setupAntigravity = (profile: string): Result<ClientSetupReport, ClientConfigFailure> =>
  writeEntry(
    join(home, '.gemini', 'config', 'mcp_config.json'),
    mergeMcpServersKey,
    withProfile(STDIO_ENTRY, profile),
    '  Reopen Antigravity or type /mcp in the CLI to refresh.',
  );

// Codex CLI MCP configuration path and format is not yet stable: describe the snippet and let the user place it.
const setupCodex = (profile: string): Result<ClientSetupReport, ClientConfigFailure> =>
  ok({
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
