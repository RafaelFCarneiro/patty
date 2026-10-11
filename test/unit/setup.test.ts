import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mergeMcpServersKey,
  mergeServersKey,
  readJsonOrEmpty,
  resolveConfigObject,
  runSetup,
  STDIO_ENTRY,
  VSCODE_ENTRY,
} from '../../src/setup.js';

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('mergeMcpServersKey', () => {
  it('adds fintrack entry to an empty config', () => {
    const result = mergeMcpServersKey({}, { ...STDIO_ENTRY });
    expect(result).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } });
  });

  it('preserves existing mcpServers entries', () => {
    const existing = { mcpServers: { other: { command: 'other-cmd', args: [] } } };
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY });
    expect(result.mcpServers).toEqual({
      other: { command: 'other-cmd', args: [] },
      fintrack: STDIO_ENTRY,
    });
  });

  it('overwrites an existing fintrack entry (idempotent)', () => {
    const existing = { mcpServers: { fintrack: { command: 'old', args: [] } } };
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY });
    expect((result.mcpServers as Record<string, unknown>)['fintrack']).toEqual(STDIO_ENTRY);
  });

  it('preserves top-level keys unrelated to mcpServers', () => {
    const existing = { someAppPreference: true, mcpServers: {} };
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY });
    expect(result['someAppPreference']).toBe(true);
  });

  it('treats a non-object mcpServers value as empty', () => {
    const existing = { mcpServers: 'corrupt' };
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY });
    expect(result).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } });
  });

  it('treats an array mcpServers value as empty', () => {
    const existing = { mcpServers: [] };
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY });
    expect(result).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } });
  });
});

describe('mergeServersKey', () => {
  it('adds fintrack entry under servers key (VS Code shape)', () => {
    const result = mergeServersKey({}, { ...VSCODE_ENTRY });
    expect(result).toEqual({ servers: { fintrack: VSCODE_ENTRY } });
  });

  it('preserves existing servers entries', () => {
    const existing = { servers: { other: { type: 'stdio', command: 'x', args: [] } } };
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY });
    expect(result.servers).toEqual({
      other: { type: 'stdio', command: 'x', args: [] },
      fintrack: VSCODE_ENTRY,
    });
  });

  it('overwrites an existing fintrack entry (idempotent)', () => {
    const existing = { servers: { fintrack: { type: 'stdio', command: 'old', args: [] } } };
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY });
    expect((result.servers as Record<string, unknown>)['fintrack']).toEqual(VSCODE_ENTRY);
  });

  it('preserves top-level keys unrelated to servers', () => {
    const existing = { inputs: [], servers: {} };
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY });
    expect(result['inputs']).toEqual([]);
  });

  it('treats a non-object servers value as empty', () => {
    const existing = { servers: null };
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY });
    expect(result).toEqual({ servers: { fintrack: VSCODE_ENTRY } });
  });

  it('treats an array servers value as empty', () => {
    const existing = { servers: [] };
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY });
    expect(result).toEqual({ servers: { fintrack: VSCODE_ENTRY } });
  });
});

describe('resolveConfigObject', () => {
  it('returns plain objects', () => {
    const config = { mcpServers: {} };
    expect(resolveConfigObject(config)).toBe(config);
  });

  it.each([null, [], 'config'])('rejects non-object config roots: %j', (value) => {
    expect(resolveConfigObject(value)).toBeNull();
  });
});

describe('readJsonOrEmpty', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty object when the file does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    expect(readJsonOrEmpty(join(tempDir, 'missing.json'))).toEqual({});
  });

  it('reports the underlying file read failure message', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    mkdirSync(configPath);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    expect(() => readJsonOrEmpty(configPath)).toThrow('process.exit:1');
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^fintrack setup: failed to read ${escapeForRegExp(configPath)}: EISDIR:`),
    );
  });

  it('treats an empty file as an empty object', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '', 'utf8');

    expect(readJsonOrEmpty(configPath)).toEqual({});
  });

  it('falls back to an empty object for malformed JSON content', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '{ invalid-json', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(readJsonOrEmpty(configPath)).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      `fintrack setup: ${configPath} does not contain a JSON object at the root — replacing it during setup.`,
    );
  });

  it('falls back to an empty object for non-object JSON roots', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '[]', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(readJsonOrEmpty(configPath)).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      `fintrack setup: ${configPath} does not contain a JSON object at the root — replacing it during setup.`,
    );
  });
});

describe('STDIO_ENTRY', () => {
  it('uses npx with the published package', () => {
    expect(STDIO_ENTRY.command).toBe('npx');
    expect(STDIO_ENTRY.args).toEqual(['-y', '@rafaelfcarneiro/fintrack@latest']);
  });
});

describe('VSCODE_ENTRY', () => {
  it('includes type:stdio required by VS Code', () => {
    expect(VSCODE_ENTRY.type).toBe('stdio');
    expect(VSCODE_ENTRY.command).toBe('npx');
  });
});

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

    const { runSetup: runSetupWithMockedHome } = await import('../../src/setup.js');
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
    return import('../../src/setup.js');
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

  it.each([[undefined, 0], ['no-such-tool', 1]] as const)(
    'never claims for help or an unknown tool (%s)',
    async (tool, exitCode) => {
      const { runGuidedSetup } = await loadWithHome();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
        throw new Error(`process.exit:${code}`);
      }) as typeof process.exit);
      const claim = vi.fn(async () => true);

      await expect(runGuidedSetup(tool, claim)).rejects.toThrow(`process.exit:${exitCode}`);
      expect(claim).not.toHaveBeenCalled();
    },
  );

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
