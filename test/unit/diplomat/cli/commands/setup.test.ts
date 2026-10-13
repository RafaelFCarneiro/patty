import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSetup as runSetupFor } from '../../../../../src/diplomat/cli/commands/setup.js';
import { clientConfigs } from '../../../../../src/diplomat/clientConfig/clients.js';
import { STDIO_ENTRY, VSCODE_ENTRY } from '../../../../../src/diplomat/clientConfig/merge.js';

const runSetup = (tool: string | undefined, profile?: string): number => runSetupFor(clientConfigs, tool, profile);

/** The setup command bound to the real client config files — imported fresh, so a test that mocks `node:os` first
 *  gets its home directory. */
const importSetup = async () => {
  const { runSetup: run, runGuidedSetup: runGuided } =
    await import('../../../../../src/diplomat/cli/commands/setup.js');
  const { clientConfigs: clients } = await import('../../../../../src/diplomat/clientConfig/clients.js');
  return {
    runSetup: (tool: string | undefined, profile?: string): number => run(clients, tool, profile),
    runGuidedSetup: (
      tool: string | undefined,
      claimOwner: () => Promise<boolean>,
      signIn?: (profile: string) => Promise<void>,
      profile?: string,
    ) => runGuided(clients, tool, claimOwner, signIn, profile),
  };
};

describe('runSetup', () => {
  let originalCwd = '';
  let homeDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCwd) process.chdir(originalCwd);
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('documents the vscode alias in help output', () => {
    const vscodeAliasHelp = 'vscode           VS Code / GitHub Copilot    (alias for copilot)';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    expect(() => runSetup(undefined)).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(vscodeAliasHelp));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('setup vscode'));
  });

  it('prints a platform-agnostic Claude Desktop restart instruction', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);

    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));

    const { runSetup: runSetupWithMockedHome } = await importSetup();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    runSetupWithMockedHome('claude-desktop');

    expect(logSpy).toHaveBeenCalledWith('  Fully quit and reopen Claude Desktop to apply.');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Cmd+Q'));
  });
});

describe('runGuidedSetup (claim the owner, then write the config)', () => {
  let originalCwd = '';
  let homeDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCwd) process.chdir(originalCwd);
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  const loadWithHome = async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    return importSetup();
  };

  const claudeCodeConfig = () => join(homeDir, '.claude', 'mcp.json');

  it('claims first and then writes the client config', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const order: string[] = [];
    const claim = vi.fn(async () => {
      order.push(existsSync(claudeCodeConfig()) ? 'config-first' : 'claim');
      return true;
    });

    expect(await runGuidedSetup('claude-code', claim)).toBe(0);

    expect(order).toEqual(['claim']);
    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8'))).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } });
  });

  it('writes no config at all when the claim fails (no terminal, bad input…)', async () => {
    const { runGuidedSetup } = await loadWithHome();
    expect(await runGuidedSetup('claude-code', async () => false)).toBe(1);
    expect(existsSync(claudeCodeConfig())).toBe(false);
  });

  it('is safe to re-run: the claim step may skip, and the config merges idempotently', async () => {
    const { runGuidedSetup } = await loadWithHome();
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(claudeCodeConfig(), JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));

    await runGuidedSetup('claude-code', async () => true);
    const once = readFileSync(claudeCodeConfig(), 'utf8');
    await runGuidedSetup('claude-code', async () => true);

    expect(readFileSync(claudeCodeConfig(), 'utf8')).toBe(once);
    expect(JSON.parse(once)).toEqual({
      mcpServers: { other: { command: 'x' }, fintrack: STDIO_ENTRY },
      theme: 'dark',
    });
  });

  it.each([
    [undefined, 0],
    ['no-such-tool', 1],
  ] as const)('never claims for help or an unknown tool (%s)', async (tool, exitCode) => {
    const { runGuidedSetup } = await loadWithHome();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const claim = vi.fn(async () => true);

    await expect(runGuidedSetup(tool, claim)).rejects.toThrow(`process.exit:${exitCode}`);
    expect(claim).not.toHaveBeenCalled();
  });

  it('documents the owner login and the scripted flags in the help', async () => {
    const { runSetup } = await loadWithHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    expect(() => runSetup(undefined)).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--password-stdin'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--username'));
  });
});

describe('runGuidedSetup — the sign-in step (ADR-034 §5.3)', () => {
  let originalCwd = '';
  let homeDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCwd) process.chdir(originalCwd);
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  const loadWithHome = async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    return importSetup();
  };

  const claudeCodeConfig = () => join(homeDir, '.claude', 'mcp.json');

  it('offers to sign in after the claim and the config, with the client’s profile', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const order: string[] = [];
    const claim = async () => {
      order.push('claim');
      return true;
    };
    const signIn = vi.fn(async (profile: string) => {
      order.push(existsSync(claudeCodeConfig()) ? `sign-in:${profile}` : 'sign-in-before-config');
    });

    expect(await runGuidedSetup('claude-code', claim, signIn)).toBe(0);

    expect(order).toEqual(['claim', 'sign-in:default']);
  });

  it('writes FINTRACK_PROFILE into the entry and signs in as that profile when one is chosen', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const signIn = vi.fn(async () => undefined);

    await runGuidedSetup('claude-code', async () => true, signIn, 'work');

    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8'))).toEqual({
      mcpServers: { fintrack: { ...STDIO_ENTRY, env: { FINTRACK_PROFILE: 'work' } } },
    });
    expect(signIn).toHaveBeenCalledWith('work');
  });

  it('puts the profile in the VS Code entry and in the Codex snippet too', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runGuidedSetup(
      'copilot',
      async () => true,
      async () => undefined,
      'work',
    );
    expect(JSON.parse(readFileSync(join(homeDir, '.vscode', 'mcp.json'), 'utf8'))).toEqual({
      servers: { fintrack: { ...VSCODE_ENTRY, env: { FINTRACK_PROFILE: 'work' } } },
    });

    await runGuidedSetup(
      'codex',
      async () => true,
      async () => undefined,
      'work',
    );
    expect(log.mock.calls.flat().join('\n')).toContain('"env": { "FINTRACK_PROFILE": "work" }');
  });

  it('writes no env at all for the default profile', async () => {
    const { runGuidedSetup } = await loadWithHome();
    await runGuidedSetup(
      'claude-code',
      async () => true,
      async () => undefined,
    );
    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8')).mcpServers.fintrack).not.toHaveProperty('env');
  });

  it('does not offer a sign-in when the claim failed', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const signIn = vi.fn(async () => undefined);
    expect(await runGuidedSetup('claude-code', async () => false, signIn)).toBe(1);
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 0],
    ['no-such-tool', 1],
  ] as const)('does not offer a sign-in for help or an unknown tool (%s)', async (tool, exitCode) => {
    const { runGuidedSetup } = await loadWithHome();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const signIn = vi.fn(async () => undefined);
    await expect(runGuidedSetup(tool, async () => true, signIn)).rejects.toThrow(`process.exit:${exitCode}`);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('documents --profile and the pinned command in the help', async () => {
    const { runSetup } = await loadWithHome();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    expect(() => runSetup(undefined)).toThrow('process.exit:0');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--profile <name>'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('npx @rafaelfcarneiro/fintrack@latest setup'));
  });
});

describe('runGuidedSetup — a client config that cannot be read or written', () => {
  let originalCwd = '';
  let homeDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCwd) process.chdir(originalCwd);
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('prints the message on stderr and answers exit code 1, with no sign-in offered and no process.exit', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit');
    const configPath = join(homeDir, '.claude', 'mcp.json');
    mkdirSync(configPath, { recursive: true }); // a directory where the file should be: reading it fails (EISDIR)
    const { runGuidedSetup } = await importSetup();
    const signIn = vi.fn(async () => undefined);

    expect(await runGuidedSetup('claude-code', async () => true, signIn)).toBe(1);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/^fintrack setup: failed to read .*mcp\.json: EISDIR:/);
    expect(log).toHaveBeenCalledWith('Setting up FinTrack MCP for Claude Code (CLI)...');
    expect(log).not.toHaveBeenCalledWith('Done.');
    expect(signIn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
