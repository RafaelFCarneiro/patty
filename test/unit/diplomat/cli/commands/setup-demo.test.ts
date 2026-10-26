import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliIo } from '../../../../../src/diplomat/cli/io.js';
import { DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT, DEMO_SERVER_NAME } from '../../../../../src/models/demo.js';

let homeDir = '';
let originalCwd = '';

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCwd) process.chdir(originalCwd);
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  vi.doUnmock('node:os');
  vi.resetModules();
});

/** `setup` bound to the real client config files under a temporary home, and an io that fails on any database or
 *  terminal use: the demo entry never claims an owner, signs in or opens a database. */
const loadSetup = async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-demo-'));
  originalCwd = process.cwd();
  process.chdir(homeDir);
  vi.resetModules();
  vi.doMock('node:os', () => ({ homedir: () => homeDir }));
  const { runSetupCommand } = await import('../../../../../src/diplomat/cli/commands/setup.js');
  const { clientConfigs } = await import('../../../../../src/diplomat/client-config/clients.js');
  const out: string[] = [];
  const err: string[] = [];
  const openShell = vi.fn();
  const openTerminal = vi.fn();
  const io = {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
    clients: clientConfigs,
    openShell,
    openTerminal,
  } as unknown as CliIo;
  return { run: (...args: string[]) => runSetupCommand(args, io), out, err, openShell, openTerminal };
};

const claudeCodeFile = () => join(homeDir, '.claude', 'mcp.json');
const readConfig = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const demoEnv = () => ({
  DB_PATH: join(homeDir, '.fintrack', 'demo.db'),
  PORT: String(DEMO_PORT),
  [DEMO_ENV_VAR]: DEMO_ENV_ON,
});

const writeConfig = (path: string, config: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
};

describe('setup <client> --demo', () => {
  it('adds fintrack-demo beside the fintrack entry, which it leaves exactly as it was', async () => {
    const { run, openShell, openTerminal } = await loadSetup();
    const real = { command: 'npx', args: ['-y', 'pinned'], env: { FINTRACK_PROFILE: 'work' } };
    writeConfig(claudeCodeFile(), { theme: 'dark', mcpServers: { fintrack: real, other: { command: 'x' } } });

    expect(await run('claude-code', '--demo')).toBe(0);

    const config = readConfig(claudeCodeFile());
    expect(config.theme).toBe('dark');
    expect(config.mcpServers.fintrack).toEqual(real);
    expect(config.mcpServers.other).toEqual({ command: 'x' });
    expect(config.mcpServers[DEMO_SERVER_NAME]).toMatchObject({ command: 'npx', env: demoEnv() });
    expect(openShell).not.toHaveBeenCalled();
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it('writes the VS Code shape for copilot, and is safe to repeat', async () => {
    const { run } = await loadSetup();
    const file = join(homeDir, '.vscode', 'mcp.json');
    expect(await run('copilot', '--demo')).toBe(0);
    const first = readFileSync(file, 'utf8');
    expect(await run('copilot', '--demo')).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(readConfig(file).servers[DEMO_SERVER_NAME]).toMatchObject({ type: 'stdio', env: demoEnv() });
    expect(readConfig(file).servers).not.toHaveProperty('fintrack');
  });

  it('writes no fintrack entry of its own when there was none, and says how to seed the data', async () => {
    const { run, out } = await loadSetup();
    expect(await run('claude-code', '--demo')).toBe(0);
    expect(Object.keys(readConfig(claudeCodeFile()).mcpServers)).toEqual([DEMO_SERVER_NAME]);
    expect(out.join('\n')).toContain(' demo ');
  });

  it('prints the Codex snippet under the demo name, with the demo environment', async () => {
    const { run, out } = await loadSetup();
    expect(await run('codex', '--demo')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`"${DEMO_SERVER_NAME}"`);
    expect(text).toContain(`"${DEMO_ENV_VAR}": "${DEMO_ENV_ON}"`);
  });

  it.each([
    [['--demo', '--remove-demo']],
    [['--demo', '--profile', 'work']],
    [['--remove-demo', '--username', 'rafael']],
    [['--demo', '--password-stdin']],
  ])('refuses to combine it with other options (%j) and writes nothing', async (flags) => {
    const { run, err } = await loadSetup();
    expect(await run('claude-code', ...flags)).toBe(1);
    expect(err.join('\n')).toContain('use them alone');
    expect(existsSync(claudeCodeFile())).toBe(false);
  });

  it('says so for an unknown client, and prints the help with no client', async () => {
    const { run, err, out } = await loadSetup();
    expect(await run('no-such-tool', '--demo')).toBe(1);
    expect(err.join('\n')).toContain('unknown tool');
    expect(await run('--demo')).toBe(0);
    expect(out.join('\n')).toContain('--demo');
  });

  it('reports a config file it cannot use, as a failure', async () => {
    const { run, err } = await loadSetup();
    mkdirSync(claudeCodeFile(), { recursive: true });
    expect(await run('claude-code', '--demo')).toBe(1);
    expect(err.join('\n')).toContain('failed to read');
  });
});

describe('setup <client> --remove-demo', () => {
  it('removes only the fintrack-demo entry', async () => {
    const { run } = await loadSetup();
    const real = { command: 'npx', args: ['-y', 'pinned'] };
    writeConfig(claudeCodeFile(), {
      theme: 'dark',
      mcpServers: { fintrack: real, other: { command: 'x' }, [DEMO_SERVER_NAME]: { command: 'npx', env: demoEnv() } },
    });

    expect(await run('claude-code', '--remove-demo')).toBe(0);

    expect(readConfig(claudeCodeFile())).toEqual({
      theme: 'dark',
      mcpServers: { fintrack: real, other: { command: 'x' } },
    });
  });

  it('removes it from the VS Code shape too', async () => {
    const { run } = await loadSetup();
    const file = join(homeDir, '.vscode', 'mcp.json');
    expect(await run('vscode', '--demo')).toBe(0);
    expect(await run('vscode', '--remove-demo')).toBe(0);
    expect(readConfig(file)).toEqual({ servers: {} });
  });

  it('creates nothing when the client has no config file', async () => {
    const { run, out } = await loadSetup();
    expect(await run('claude-code', '--remove-demo')).toBe(0);
    expect(existsSync(claudeCodeFile())).toBe(false);
    expect(out.join('\n')).toContain('No demo entry to remove');
  });

  it('leaves a file with no demo entry byte for byte as it is', async () => {
    const { run, out } = await loadSetup();
    writeConfig(claudeCodeFile(), { mcpServers: { fintrack: { command: 'npx' } } });
    const before = { text: readFileSync(claudeCodeFile(), 'utf8'), mtime: statSync(claudeCodeFile()).mtimeMs };
    expect(await run('claude-code', '--remove-demo')).toBe(0);
    expect(readFileSync(claudeCodeFile(), 'utf8')).toBe(before.text);
    expect(statSync(claudeCodeFile()).mtimeMs).toBe(before.mtime);
    expect(out.join('\n')).toContain(`No ${DEMO_SERVER_NAME} entry`);
  });

  it('tells a Codex user which entry to remove, and touches no file', async () => {
    const { run, out } = await loadSetup();
    expect(await run('codex', '--remove-demo')).toBe(0);
    expect(out.join('\n')).toContain(DEMO_SERVER_NAME);
  });
});
