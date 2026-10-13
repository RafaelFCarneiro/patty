# Feature Design 010: `setup` subcommand for one-command MCP client configuration

**Type:** Feature design · **Design status:** Accepted ·
**Implementation status:** Done · **Branch:** `feat/mcp-setup-command` ·
**Date:** 2026-06-29 · Additive CLI subcommand — no domain changes.

> **Implementation status** tracks delivery, distinct from the design's acceptance. Values:
> `Not started` · `In progress` · `Done` · `Blocked`. The implementing PR updates this line (→ `In progress`
> when work starts, → `Done` on merge); use `Blocked` with a one-line reason if stuck.

> **Where it lives now:** the `setup` module this design describes is `src/diplomat/cli/commands/setup.ts` (the command) and
> `src/diplomat/clientConfig/` (the merge helpers and the file writes); the text below keeps the original design's names.

## Context

Connecting FinTrack's MCP server to an AI client requires editing a JSON config file whose
path, root key, and entry shape vary by client. The manual steps are documented in
`docs/mcp-clients.md`, but they introduce friction and copy-paste error surface:

- **Each client is different.** Claude Desktop uses `mcpServers` in an OS-specific path;
  VS Code uses `servers` (with `type: "stdio"`) in `.vscode/mcp.json`; Claude Code uses
  `~/.claude/mcp.json`; Google Antigravity uses `~/.gemini/config/mcp_config.json`.
- **Existing config must be preserved.** Files like `claude_desktop_config.json` hold app
  preferences alongside `mcpServers` — a naive overwrite breaks the app.
- **The package is already on the user's machine** at `npx` invocation time, so there is no
  extra dependency to install for setup.

The goal: one command per client, safe to re-run, cross-platform (macOS, Linux, Windows).

## Decision

Add a `setup` subcommand to the existing `fintrack` binary:

```bash
npx @rafaelfcarneiro/fintrack@latest setup <tool>
```

- **Branching happens before `loadConfig()`** in `main.ts` — no env-var parsing, no DB
  open, no keychain access. Setup is a pure filesystem operation, completely isolated from
  the server startup path.
- **Writes are idempotent merges.** The command reads the existing config (or `{}` if the
  file is absent), merges `fintrack` under the appropriate root key, and writes back with
  2-space indent. Running it twice on the same client is safe.
- **No server needs to be running.** The subcommand exits immediately after writing; it does
  not start the MCP server.

### Supported tools

| Argument | Client | Config file written |
|---|---|---|
| `claude-code` | Claude Code CLI | `~/.claude/mcp.json` |
| `claude-desktop` | Claude Desktop | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json`<br>Linux: `~/.config/Claude/claude_desktop_config.json` |
| `copilot` / `vscode` | VS Code / GitHub Copilot | `.vscode/mcp.json` in the current working directory |
| `antigravity` | Google Antigravity (2.0, CLI, IDE) | `~/.gemini/config/mcp_config.json` |
| `codex` | OpenAI Codex | Prints the JSON snippet to paste (config path not yet stable) |

Running without an argument prints the full usage and exits with code 0.
Running with an unknown tool prints an error and exits with code 1.

### Entry shapes

Most clients share the `mcpServers` root key:
```json
{
  "mcpServers": {
    "fintrack": { "command": "npx", "args": ["-y", "@rafaelfcarneiro/fintrack@latest"] }
  }
}
```

VS Code requires an additional `type` field and uses `servers` (not `mcpServers`):
```json
{
  "servers": {
    "fintrack": { "type": "stdio", "command": "npx", "args": ["-y", "@rafaelfcarneiro/fintrack@latest"] }
  }
}
```

## Scope / out of scope

- **In:** `src/setup.ts` (merge logic + FS writes); `main.ts` branch; unit tests for the
  pure merge functions; `README.md` and `docs/mcp-clients.md` updated with the command;
  cross-platform paths for all supported clients.
- **Out:** interactive TUI/picker (plain `--help` output is sufficient); HTTP-mode setup
  (the setup command targets the default stdio transport); uninstall/remove support; Ollama
  (it is not an MCP client — a bridge is required; the existing `mcp-clients.md` section
  covers it).

## Options Considered

### `npx @rafaelfcarneiro/fintrack@latest setup <tool>` — **chosen**

Ships inside the existing package. Zero extra dependencies. Cross-platform (Node.js handles
path differences). The branching in `main.ts` keeps it completely decoupled from server
startup. Idempotent.

### Separate bash script (e.g. `scripts/setup-mcp.sh`)

Simpler to write, but shell-only (not portable to Windows), harder to keep cross-platform,
and not bundled into the published package — users would need to clone the repo or curl
a raw URL. Rejected in favour of the Node.js subcommand.

### Interactive picker (no tool argument — always prompts)

Would require an interactive terminal and a dependency (e.g. `inquirer`). The explicit
argument is faster, scriptable, and requires no extra package. A `--help`/no-argument
fallback covers discoverability.

## Consequences

- **`main.ts`** gains a 4-line branch at the top of `main()`, before `loadConfig()`. No
  change to the server startup path.
- **`src/setup.ts`** is a standalone module: imports only Node built-ins (`fs`, `os`,
  `path`). It exports `runSetup`, `mergeMcpServersKey`, `mergeServersKey`, `STDIO_ENTRY`,
  and `VSCODE_ENTRY` — the pure functions are exported for unit testing.
- **No domain or architectural invariants are affected.** The module does not import
  anything from `controllers/`, `logic/`, `diplomat/`, or `models/`.
- **`docs/mcp-clients.md`** gains a "One-command setup" table at the top. The manual
  per-client JSON sections remain for users who prefer manual control.
- **`README.md`** leads the "Connecting to AI clients" section with the `setup` command
  before the manual snippets.

---

## Implementation prompt

> Hand this to a coding agent. Source of truth: this design. Work on branch
> **`feat/mcp-setup-command`** off `main`; `git fetch && git rebase origin/main` first.
> **Follow the project guidelines — mandatory:** read `CLAUDE.md` (esp. the **Definition of
> Done**), `docs/architecture.md`, `docs/code-style.md`, `docs/code-quality.md`.
> Skim `src/main.ts` (the composition root and the branching point) and
> `src/config.ts` (to understand what `loadConfig()` does and why setup must branch before it).

### Steps

1. **`src/setup.ts`** — create a standalone module (Node built-ins only, no domain
   imports). Export:
   - `STDIO_ENTRY` and `VSCODE_ENTRY` — the config entry shapes (constants, not literals).
   - `mergeMcpServersKey(existing, entry)` — pure function: returns a new config object with
     `existing.mcpServers.fintrack` set to `entry`; preserves all other top-level keys and
     other `mcpServers` entries; treats a non-object `mcpServers` value as empty.
   - `mergeServersKey(existing, entry)` — same but under the `servers` key (VS Code shape).
   - `runSetup(tool: string | undefined): void` — dispatches to per-client handlers based on
     the tool argument; prints usage and exits 0 when `tool` is `undefined`; exits 1 with an
     error message for unknown tools.
   - Per-client handlers: `setupClaudeCode`, `setupClaudeDesktop`, `setupCopilot`,
     `setupAntigravity`, `setupCodex`. Each reads the existing file (or `{}`), merges, writes
     back (creating parent directories as needed), and prints a one-line confirmation plus the
     next step for the user.
   - `setupClaudeDesktop` must resolve the config path per OS (`process.platform`):
     `darwin` → `~/Library/Application Support/Claude/claude_desktop_config.json`;
     `win32` → `%APPDATA%\Claude\claude_desktop_config.json`;
     default → `~/.config/Claude/claude_desktop_config.json`.
   - All `console.*` calls carry an `eslint-disable-next-line no-console` comment (ADR-007
     restricts stdout in stdio mode; the lint rule allows `console.error`/`warn` but not
     `console.log`). Use `console.log` only; if the rule flags it, suppress per-line.

2. **`src/main.ts`** — at the top of `main()`, before `const config = loadConfig()`:
   ```ts
   if (process.argv[2] === 'setup') {
     const { runSetup } = await import('./setup.js')
     runSetup(process.argv[3])
     return
   }
   ```
   The dynamic import keeps `setup.ts` out of the server startup critical path.

3. **`docs/mcp-clients.md`** — prepend a "One-command setup" section with the command table
   (tool → client → config file). Keep the existing manual per-client sections.

4. **`README.md`** — update the "Connecting to AI clients" section to lead with the setup
   command; add Google Antigravity to the manual snippets alongside the existing clients.

### Tests

- **Unit (`test/unit/setup.test.ts`)** — test the pure merge functions only (no FS):
  - `mergeMcpServersKey`: empty config, existing entries preserved, fintrack overwritten
    (idempotent), top-level keys preserved, non-object `mcpServers` treated as empty.
  - `mergeServersKey`: same cases for the VS Code shape.
  - Assert `STDIO_ENTRY` uses `npx` + the published package name.
  - Assert `VSCODE_ENTRY` carries `type: "stdio"`.
- No integration tests needed — the FS layer is a thin wrapper over the pure functions.

### Gate

```bash
npm run lint && npm run typecheck && npm run test:all && npm run build
```

### Invariants — do not break

- `main.ts` branches **before** `loadConfig()` — setup must never open the database or the
  keychain.
- All config writes are **merges** — never a full file overwrite that discards existing keys.
- `src/setup.ts` imports **only** Node built-ins (`node:fs`, `node:os`, `node:path`).
