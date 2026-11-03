import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { err, ok, Result } from 'neverthrow';
import * as R from 'remeda';
import type { ClientConfig, ClientConfigs, ClientSetupReport } from '../../controllers/deps.js';
import { DEFAULT_PROFILE, PROFILE_ENV_VAR } from '../../models/auth/sign-in.js';
import { clientConfigFailures, type ClientConfigFailure } from '../../models/client-config.js';
import { DEMO_SERVER_NAME } from '../../models/demo/demo.js';
import { PACKAGE_SPEC } from '../../models/package.js';
import { ServersKey } from '../../wire/out/client-config.js';
import {
  mergeMcpServersKey,
  mergeServersKey,
  resolveConfigObject,
  SERVER_NAME,
  STDIO_ENTRY,
  VSCODE_ENTRY,
  withDemo,
  withoutServer,
  withProfile,
} from './merge.js';

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

const INVALID_ROOT_MESSAGE = 'does not contain a JSON object at the root';

const invalidConfigWarning = (path: string): string =>
  `fintrack setup: ${path} ${INVALID_ROOT_MESSAGE} — replacing it during setup.`;

// The throwing system calls, wrapped once: everything below this block is Results.
const readText = Result.fromThrowable((path: string) => readFileSync(path, 'utf8'), R.identity());
const writeText = Result.fromThrowable((path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}, R.identity());
const parseJson = Result.fromThrowable((text: string): unknown => JSON.parse(text), R.identity());

type ConfigRead = { config: Record<string, unknown>; warnings: string[] };

type WhenUnusable = (path: string) => Result<ConfigRead, ClientConfigFailure>;

const replaceUnusable: WhenUnusable = (path) => ok({ config: {}, warnings: [invalidConfigWarning(path)] });

const refuseUnusable: WhenUnusable = (path) =>
  err(clientConfigFailures.readFailed(path, `${INVALID_ROOT_MESSAGE}, or is not plain JSON — left unchanged`));

/** The demo entry refuses an unusable file instead of replacing it. */
export const readJsonOrEmpty = (
  path: string,
  whenUnusable: WhenUnusable = replaceUnusable,
): Result<ConfigRead, ClientConfigFailure> => {
  if (!existsSync(path)) return ok({ config: {}, warnings: [] });
  return readText(path)
    .mapErr((cause) => clientConfigFailures.readFailed(path, cause))
    .andThen((content): Result<ConfigRead, ClientConfigFailure> => {
      const trimmed = content.trim();
      if (!trimmed) return ok({ config: {}, warnings: [] });
      const config = parseJson(trimmed).map(resolveConfigObject).unwrapOr(null);
      return config ? ok({ config, warnings: [] }) : whenUnusable(path);
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

type ConfigReport = Result<ClientSetupReport, ClientConfigFailure>;

/** Reads the client's file, merges the FinTrack entry in, writes it back, and reports. */
const writeEntry = (
  configPath: string,
  merge: (existing: Record<string, unknown>, entry: Record<string, unknown>) => Record<string, unknown>,
  entry: Record<string, unknown>,
  next: string,
  whenUnusable: WhenUnusable = replaceUnusable,
): ConfigReport =>
  readJsonOrEmpty(configPath, whenUnusable).andThen(({ config, warnings }) =>
    writeJson(configPath, merge(config, entry))
      .map((): ClientSetupReport => ({ warnings, lines: [`  Updated: ${configPath}`, next] }))
      // What was raised while reading is still owed to the person, ahead of the failure.
      .mapErr((failure) => ({ ...failure, warnings })),
  );

const nothingToRemove = (reason: string): ConfigReport => ok({ warnings: [], lines: [`  ${reason}`] });

const removeDemoEntry = (configPath: string, key: ServersKey, next: string): ConfigReport => {
  if (!existsSync(configPath)) return nothingToRemove(`No demo entry to remove: ${configPath} does not exist`);
  return readJsonOrEmpty(configPath, refuseUnusable).andThen(({ config, warnings }) => {
    const without = withoutServer(config, key, DEMO_SERVER_NAME);
    if (without === null) return nothingToRemove(`No ${DEMO_SERVER_NAME} entry in ${configPath}`);
    return writeJson(configPath, without)
      .map((): ClientSetupReport => ({ warnings, lines: [`  Removed ${DEMO_SERVER_NAME} from ${configPath}`, next] }))
      .mapErr((failure) => ({ ...failure, warnings }));
  });
};

type FileClient = {
  label: string;
  path: () => string;
  key: ServersKey;
  entry: Record<string, unknown>;
  next: string;
};

const MERGE_BY_KEY = {
  [ServersKey.enum.mcpServers]: mergeMcpServersKey,
  [ServersKey.enum.servers]: mergeServersKey,
} as const satisfies Record<ServersKey, typeof mergeMcpServersKey>;

const fileClient = ({ label, path, key, entry, next }: FileClient): ClientConfig => ({
  label,
  run: (profile) => writeEntry(path(), MERGE_BY_KEY[key], withProfile(entry, profile), next),
  addDemo: (databasePath) =>
    writeEntry(
      path(),
      (existing, demoEntry) => MERGE_BY_KEY[key](existing, demoEntry, DEMO_SERVER_NAME),
      withDemo(entry, databasePath),
      next,
      refuseUnusable,
    ),
  removeDemo: () => removeDemoEntry(path(), key, next),
});

// Codex CLI MCP configuration path and format is not yet stable: describe the snippet and let the user place it.
/** JSON-escaped: a path may hold backslashes or quotes. */
const inlineObject = (env: Record<string, string>): string =>
  `{ ${Object.entries(env)
    .map(([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`)
    .join(', ')} }`;

const codexSnippet = (
  name: string,
  env: Record<string, string> | null,
): string => `  Codex CLI: add the following to your MCP config file:

  {
    "mcpServers": {
      "${name}": {
        "command": "npx",
        "args": ["-y", "${PACKAGE_SPEC}"]${env === null ? '' : `,\n        "env": ${inlineObject(env)}`}
      }
    }
  }

  Refer to the Codex CLI docs for the exact config file location.`;

const setupCodex = (profile: string): ConfigReport =>
  ok({
    warnings: [],
    lines: [codexSnippet(SERVER_NAME, profile === DEFAULT_PROFILE ? null : { [PROFILE_ENV_VAR]: profile })],
  });

const codex: ClientConfig = {
  label: 'OpenAI Codex',
  run: setupCodex,
  addDemo: (databasePath) =>
    ok({ warnings: [], lines: [codexSnippet(DEMO_SERVER_NAME, withDemo(STDIO_ENTRY, databasePath).env)] }),
  removeDemo: () =>
    ok({ warnings: [], lines: [`  Codex CLI: remove the "${DEMO_SERVER_NAME}" entry from your MCP config file.`] }),
};

// ---------------------------------------------------------------------------
// Client registry
// ---------------------------------------------------------------------------

const claudeCode = fileClient({
  label: 'Claude Code (CLI)',
  path: () => join(home, '.claude', 'mcp.json'),
  key: ServersKey.enum.mcpServers,
  entry: STDIO_ENTRY,
  next: '  Verify with: claude mcp list',
});
const claudeDesktop = fileClient({
  label: 'Claude Desktop',
  path: claudeDesktopConfigPath,
  key: ServersKey.enum.mcpServers,
  entry: STDIO_ENTRY,
  next: '  Fully quit and reopen Claude Desktop to apply.',
});
const copilot = fileClient({
  label: 'VS Code / GitHub Copilot',
  path: () => join(process.cwd(), '.vscode', 'mcp.json'),
  key: ServersKey.enum.servers,
  entry: VSCODE_ENTRY,
  next: '  Reload VS Code window (Cmd/Ctrl+Shift+P → "Developer: Reload Window") to apply.',
});
const antigravity = fileClient({
  label: 'Google Antigravity',
  path: () => join(home, '.gemini', 'config', 'mcp_config.json'),
  key: ServersKey.enum.mcpServers,
  entry: STDIO_ENTRY,
  next: '  Reopen Antigravity or type /mcp in the CLI to refresh.',
});

const TOOLS: Readonly<Record<string, ClientConfig>> = {
  'claude-code': claudeCode,
  'claude-desktop': claudeDesktop,
  copilot,
  vscode: copilot,
  antigravity,
  codex,
};

const findClient = (tool: string): ClientConfig | undefined => TOOLS[tool.trim().toLowerCase()];

export const clientConfigs: ClientConfigs = { find: findClient };
