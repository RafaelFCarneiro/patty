import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfigs } from '../../../../../src/controllers/deps.js';
import { EXIT_FAILURE, EXIT_OK } from '../../../../../src/diplomat/cli/io.js';
import { runSetup as runSetupFor } from '../../../../../src/diplomat/cli/commands/setup.js';
import { clientConfigs } from '../../../../../src/diplomat/client-config/clients.js';
import { STDIO_ENTRY, VSCODE_ENTRY } from '../../../../../src/diplomat/client-config/merge.js';

/** The I/O `setup` prints through, captured. */
const captureIo = (clients: ClientConfigs) => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line), clients } };
};

const runSetup = (tool: string | undefined, profile?: string) => {
  const captured = captureIo(clientConfigs);
  return { exit: runSetupFor(captured.io, tool, profile), out: captured.out, err: captured.err };
};

/** The setup command bound to the real client config files — imported fresh, so a test that mocks `node:os` first
 *  gets its home directory. */
const importSetup = async () => {
  const { runSetup: run, runGuidedSetup: runGuided } =
    await import('../../../../../src/diplomat/cli/commands/setup.js');
  const { clientConfigs: clients } = await import('../../../../../src/diplomat/client-config/clients.js');
  const { io, out, err } = captureIo(clients);
  return {
    out,
    err,
    runSetup: (tool: string | undefined, profile?: string): number => run(io, tool, profile),
    runGuidedSetup: (
      tool: string | undefined,
      claimOwner: () => Promise<number>,
      signIn?: (profile: string) => Promise<number | undefined>,
      profile?: string,
    ) => runGuided(io, tool, claimOwner, signIn, profile),
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
    const { exit, out, err } = runSetup(undefined);

    expect(exit).toBe(0);
    expect(out).toEqual([expect.stringContaining(vscodeAliasHelp)]);
    expect(out[0]).toContain('setup vscode');
    expect(err).toEqual([]);
  });

  it('prints a platform-agnostic Claude Desktop restart instruction', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);

    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));

    const { runSetup: runSetupWithMockedHome, out } = await importSetup();

    expect(runSetupWithMockedHome('claude-desktop')).toBe(0);

    expect(out).toContain('  Fully quit and reopen Claude Desktop to apply.');
    expect(out.join('\n')).not.toContain('Cmd+Q');
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
    return importSetup();
  };

  const claudeCodeConfig = () => join(homeDir, '.claude', 'mcp.json');

  it('claims first and then writes the client config', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const order: string[] = [];
    const claim = vi.fn(async () => {
      order.push(existsSync(claudeCodeConfig()) ? 'config-first' : 'claim');
      return EXIT_OK;
    });

    expect(await runGuidedSetup('claude-code', claim)).toBe(0);

    expect(order).toEqual(['claim']);
    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8'))).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } });
  });

  it('writes no config at all when the claim fails (no terminal, bad input…)', async () => {
    const { runGuidedSetup } = await loadWithHome();
    expect(await runGuidedSetup('claude-code', async () => EXIT_FAILURE)).toBe(1);
    expect(existsSync(claudeCodeConfig())).toBe(false);
  });

  it('is safe to re-run: the claim step may skip, and the config merges idempotently', async () => {
    const { runGuidedSetup } = await loadWithHome();
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(claudeCodeConfig(), JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));

    await runGuidedSetup('claude-code', async () => EXIT_OK);
    const once = readFileSync(claudeCodeConfig(), 'utf8');
    await runGuidedSetup('claude-code', async () => EXIT_OK);

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
    const { runGuidedSetup, err } = await loadWithHome();
    const claim = vi.fn(async () => EXIT_OK);

    expect(await runGuidedSetup(tool, claim)).toBe(exitCode);
    expect(claim).not.toHaveBeenCalled();
    expect(existsSync(claudeCodeConfig())).toBe(false);
    expect(err.length > 0).toBe(exitCode === 1);
  });

  it('documents the owner login and the scripted flags in the help', async () => {
    const { runSetup, out } = await loadWithHome();
    expect(runSetup(undefined)).toBe(0);
    expect(out.join('\n')).toContain('--password-stdin');
    expect(out.join('\n')).toContain('--username');
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
    return importSetup();
  };

  const claudeCodeConfig = () => join(homeDir, '.claude', 'mcp.json');

  it('offers to sign in after the claim and the config, with the client’s profile', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const order: string[] = [];
    const claim = async () => {
      order.push('claim');
      return EXIT_OK;
    };
    const signIn = vi.fn(async (profile: string) => {
      order.push(existsSync(claudeCodeConfig()) ? `sign-in:${profile}` : 'sign-in-before-config');
      return undefined;
    });

    expect(await runGuidedSetup('claude-code', claim, signIn)).toBe(0);

    expect(order).toEqual(['claim', 'sign-in:default']);
  });

  it('writes FINTRACK_PROFILE into the entry and signs in as that profile when one is chosen', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const signIn = vi.fn(async () => undefined);

    await runGuidedSetup('claude-code', async () => EXIT_OK, signIn, 'work');

    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8'))).toEqual({
      mcpServers: { fintrack: { ...STDIO_ENTRY, env: { FINTRACK_PROFILE: 'work' } } },
    });
    expect(signIn).toHaveBeenCalledWith('work');
  });

  it('puts the profile in the VS Code entry and in the Codex snippet too', async () => {
    const { runGuidedSetup, out } = await loadWithHome();

    await runGuidedSetup(
      'copilot',
      async () => EXIT_OK,
      async () => undefined,
      'work',
    );
    expect(JSON.parse(readFileSync(join(homeDir, '.vscode', 'mcp.json'), 'utf8'))).toEqual({
      servers: { fintrack: { ...VSCODE_ENTRY, env: { FINTRACK_PROFILE: 'work' } } },
    });

    await runGuidedSetup(
      'codex',
      async () => EXIT_OK,
      async () => undefined,
      'work',
    );
    expect(out.join('\n')).toContain('"env": { "FINTRACK_PROFILE": "work" }');
  });

  it('writes no env at all for the default profile', async () => {
    const { runGuidedSetup } = await loadWithHome();
    await runGuidedSetup(
      'claude-code',
      async () => EXIT_OK,
      async () => undefined,
    );
    expect(JSON.parse(readFileSync(claudeCodeConfig(), 'utf8')).mcpServers.fintrack).not.toHaveProperty('env');
  });

  it('does not offer a sign-in when the claim failed', async () => {
    const { runGuidedSetup } = await loadWithHome();
    const signIn = vi.fn(async () => undefined);
    expect(await runGuidedSetup('claude-code', async () => EXIT_FAILURE, signIn)).toBe(1);
    expect(signIn).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 0],
    ['no-such-tool', 1],
  ] as const)('does not offer a sign-in for help or an unknown tool (%s)', async (tool, exitCode) => {
    const { runGuidedSetup } = await loadWithHome();
    const signIn = vi.fn(async () => undefined);
    expect(await runGuidedSetup(tool, async () => EXIT_OK, signIn)).toBe(exitCode);
    expect(signIn).not.toHaveBeenCalled();
  });

  it('documents --profile and the pinned command in the help', async () => {
    const { runSetup, out } = await loadWithHome();
    expect(runSetup(undefined)).toBe(0);
    expect(out.join('\n')).toContain('--profile <name>');
    expect(out.join('\n')).toContain('npx @rafaelfcarneiro/fintrack@latest setup');
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
    const exit = vi.spyOn(process, 'exit');
    const configPath = join(homeDir, '.claude', 'mcp.json');
    mkdirSync(configPath, { recursive: true }); // a directory where the file should be: reading it fails (EISDIR)
    const { runGuidedSetup, out, err } = await importSetup();
    const signIn = vi.fn(async () => undefined);

    expect(await runGuidedSetup('claude-code', async () => EXIT_OK, signIn)).toBe(1);

    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^fintrack setup: failed to read .*mcp\.json: EISDIR:/);
    expect(out).toEqual(['Setting up FinTrack MCP for Claude Code (CLI)...']);
    expect(signIn).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('runSetup — help and an unknown tool', () => {
  it('help prints on out and is EXIT_OK; it touches nothing and never ends the process', () => {
    const exit = vi.spyOn(process, 'exit');
    const { exit: code, out, err } = runSetup(undefined);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(err).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('an unknown tool prints the message on err and is EXIT_FAILURE, without ending the process', () => {
    const exit = vi.spyOn(process, 'exit');
    const { exit: code, out, err } = runSetup('no-such-tool');
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([
      'fintrack setup: unknown tool "no-such-tool"\n\nRun without arguments to see available tools.',
    ]);
    expect(exit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe('runGuidedSetup — everything a successful setup prints, in order', () => {
  let originalCwd = '';
  let homeDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCwd) process.chdir(originalCwd);
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('says Setting up…, Updated…, the next step, then Done. — all on out, nothing on err', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));
    const log = vi.spyOn(console, 'log');
    const { runGuidedSetup, out, err } = await importSetup();

    expect(await runGuidedSetup('claude-code', async () => EXIT_OK)).toBe(0);

    expect(out).toEqual([
      'Setting up FinTrack MCP for Claude Code (CLI)...',
      `  Updated: ${join(homeDir, '.claude', 'mcp.json')}`,
      '  Verify with: claude mcp list',
      'Done.',
    ]);
    expect(err).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('puts a replaced-config warning on err, ahead of the lines on out', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    originalCwd = process.cwd();
    process.chdir(homeDir);
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => homeDir }));
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'mcp.json'), '[]', 'utf8');
    const { runGuidedSetup, out, err } = await importSetup();

    expect(await runGuidedSetup('claude-code', async () => EXIT_OK)).toBe(0);

    expect(err).toEqual([expect.stringMatching(/mcp\.json does not contain a JSON object at the root/)]);
    expect(out).toHaveLength(4);
  });
});
