import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Shared MCP entry shapes
// ---------------------------------------------------------------------------

export const STDIO_ENTRY = {
  command: 'npx',
  args: ['-y', '@rafaelfcarneiro/fintrack'],
} as const

export const VSCODE_ENTRY = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@rafaelfcarneiro/fintrack'],
} as const

// ---------------------------------------------------------------------------
// Pure config merge helpers (testable without FS)
// ---------------------------------------------------------------------------

/** Merges `{ mcpServers: { fintrack: entry } }` into an existing config object. */
export const mergeMcpServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const servers =
    typeof existing['mcpServers'] === 'object' && existing['mcpServers'] !== null
      ? (existing['mcpServers'] as Record<string, unknown>)
      : {}
  return { ...existing, mcpServers: { ...servers, fintrack: entry } }
}

/** Merges `{ servers: { fintrack: entry } }` into an existing config object (VS Code shape). */
export const mergeServersKey = (
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> => {
  const servers =
    typeof existing['servers'] === 'object' && existing['servers'] !== null
      ? (existing['servers'] as Record<string, unknown>)
      : {}
  return { ...existing, servers: { ...servers, fintrack: entry } }
}

// ---------------------------------------------------------------------------
// FS helpers
// ---------------------------------------------------------------------------

const readJsonOrEmpty = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    console.error(`fintrack setup: ${path} exists but is not valid JSON — fix it and retry.`)
    process.exit(1)
  }
}

const writeJson = (path: string, data: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Platform-aware config path helpers
// ---------------------------------------------------------------------------

const home = homedir()

const claudeDesktopConfigPath = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

// ---------------------------------------------------------------------------
// Per-client setup handlers
// ---------------------------------------------------------------------------

const setupClaudeCode = (): void => {
  const configPath = join(home, '.claude', 'mcp.json')
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), { ...STDIO_ENTRY }))
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`)
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Verify with: claude mcp list')
}

const setupClaudeDesktop = (): void => {
  const configPath = claudeDesktopConfigPath()
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), { ...STDIO_ENTRY }))
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`)
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Fully quit (Cmd+Q) and reopen Claude Desktop to apply.')
}

const setupCopilot = (): void => {
  const configPath = join(process.cwd(), '.vscode', 'mcp.json')
  writeJson(configPath, mergeServersKey(readJsonOrEmpty(configPath), { ...VSCODE_ENTRY }))
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`)
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Reload VS Code window (Cmd/Ctrl+Shift+P → "Developer: Reload Window") to apply.')
}

const setupAntigravity = (): void => {
  const configPath = join(home, '.gemini', 'config', 'mcp_config.json')
  writeJson(configPath, mergeMcpServersKey(readJsonOrEmpty(configPath), { ...STDIO_ENTRY }))
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Updated: ${configPath}`)
  // eslint-disable-next-line no-console -- CLI surface
  console.log('  Reopen Antigravity or type /mcp in the CLI to refresh.')
}

const setupCodex = (): void => {
  // Codex CLI MCP configuration path and format is not yet stable.
  // Print the snippet and let the user place it manually.
  // eslint-disable-next-line no-console -- CLI surface
  console.log(`  Codex CLI: add the following to your MCP config file:

  {
    "mcpServers": {
      "fintrack": {
        "command": "npx",
        "args": ["-y", "@rafaelfcarneiro/fintrack"]
      }
    }
  }

  Refer to the Codex CLI docs for the exact config file location.`)
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ClientTool {
  readonly label: string
  readonly run: () => void
}

const TOOLS: Readonly<Record<string, ClientTool>> = {
  'claude-code':    { label: 'Claude Code (CLI)',       run: setupClaudeCode },
  'claude-desktop': { label: 'Claude Desktop',          run: setupClaudeDesktop },
  'copilot':        { label: 'VS Code / GitHub Copilot', run: setupCopilot },
  'vscode':         { label: 'VS Code / GitHub Copilot', run: setupCopilot },
  'antigravity':    { label: 'Google Antigravity',      run: setupAntigravity },
  'codex':          { label: 'OpenAI Codex',            run: setupCodex },
}

const HELP = `
Usage: npx @rafaelfcarneiro/fintrack setup <tool>

Available tools:
  claude-code      Claude Code CLI      (~/.claude/mcp.json)
  claude-desktop   Claude Desktop       (OS-specific config path)
  copilot          VS Code / Copilot    (.vscode/mcp.json in current directory)
  antigravity      Google Antigravity   (~/.gemini/config/mcp_config.json)
  codex            OpenAI Codex         (prints the config snippet to paste)

Examples:
  npx @rafaelfcarneiro/fintrack setup claude-code
  npx @rafaelfcarneiro/fintrack setup copilot
  npx @rafaelfcarneiro/fintrack setup antigravity
`.trimStart()

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const runSetup = (tool: string | undefined): void => {
  if (!tool) {
    // eslint-disable-next-line no-console -- CLI surface
    console.log(HELP)
    process.exit(0)
  }

  const client = TOOLS[tool.toLowerCase()]
  if (!client) {
    console.error(`fintrack setup: unknown tool "${tool}"\n\nRun without arguments to see available tools.`)
    process.exit(1)
  }

  // eslint-disable-next-line no-console -- CLI surface
  console.log(`Setting up FinTrack MCP for ${client.label}...`)
  client.run()
  // eslint-disable-next-line no-console -- CLI surface
  console.log('Done.')
}
