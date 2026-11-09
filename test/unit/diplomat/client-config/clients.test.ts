import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientConfigFailureCode } from '../../../../src/models/client-config.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonOrEmpty } from '../../../../src/diplomat/client-config/clients.js';

describe('readJsonOrEmpty', () => {
  let tempDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an empty object when the file does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'patty-setup-'));
    expect(readJsonOrEmpty(join(tempDir, 'missing.json'))._unsafeUnwrap()).toEqual({ config: {}, warnings: [] });
  });

  it('reports the underlying file read failure message', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'patty-setup-'));
    const configPath = join(tempDir, 'config.json');
    mkdirSync(configPath);

    const exitSpy = vi.spyOn(process, 'exit');

    const failure = readJsonOrEmpty(configPath)._unsafeUnwrapErr();

    expect(failure).toMatchObject({ code: ClientConfigFailureCode.enum.read_failed, path: configPath, warnings: [] });
    expect(failure.reason).toMatch(/^EISDIR:/);
    expect(exitSpy).not.toHaveBeenCalled(); // it reports; the setup command decides what to do
  });

  it('treats an empty file as an empty object', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'patty-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '', 'utf8');

    expect(readJsonOrEmpty(configPath)._unsafeUnwrap()).toEqual({ config: {}, warnings: [] });
  });

  it('falls back to an empty object for malformed JSON content', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'patty-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '{ invalid-json', 'utf8');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(readJsonOrEmpty(configPath)._unsafeUnwrap()).toEqual({
      config: {},
      warnings: [
        `patty setup: ${configPath} does not contain a JSON object at the root — replacing it during setup.`,
      ],
    });
    expect(errorSpy).not.toHaveBeenCalled(); // it reports; the setup command prints
  });

  it('falls back to an empty object for non-object JSON roots', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'patty-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '[]', 'utf8');

    expect(readJsonOrEmpty(configPath)._unsafeUnwrap()).toEqual({
      config: {},
      warnings: [
        `patty setup: ${configPath} does not contain a JSON object at the root — replacing it during setup.`,
      ],
    });
  });

  it('returns the object it finds, with no warning', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'patty-setup-'));
    const configPath = join(tempDir, 'config.json');
    writeFileSync(configPath, '{"theme":"dark"}', 'utf8');

    expect(readJsonOrEmpty(configPath)._unsafeUnwrap()).toEqual({ config: { theme: 'dark' }, warnings: [] });
  });
});

describe('what each client reports', () => {
  let home = '';
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:os');
    vi.resetModules();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const withHome = async () => {
    home = mkdtempSync(join(tmpdir(), 'patty-clients-'));
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => home }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { clientConfigs } = await import('../../../../src/diplomat/client-config/clients.js');
    return { clientConfigs, log, error };
  };

  it.each([
    ['claude-code', '  Verify with: claude mcp list'],
    ['antigravity', '  Reopen Antigravity or type /mcp in the CLI to refresh.'],
  ])('%s reports where it wrote and what to do next — and prints nothing itself', async (tool, next) => {
    const { clientConfigs, log, error } = await withHome();
    const report = clientConfigs.find(tool)!.run('default')._unsafeUnwrap();
    expect(report.warnings).toEqual([]);
    expect(report.lines).toEqual([expect.stringMatching(/^ {2}Updated: .*\.json$/), next]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('finds a client ignoring surrounding space and case; an unknown name is undefined', async () => {
    const { clientConfigs } = await withHome();
    expect(clientConfigs.find('  Claude-Code ')).toBe(clientConfigs.find('claude-code'));
    expect(clientConfigs.find('claude-code')).toBeDefined();
    expect(clientConfigs.find('no-such-client')).toBeUndefined();
  });

  it('carries the warning of a config it had to replace, and still writes', async () => {
    const { clientConfigs } = await withHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'mcp.json'), '[]', 'utf8');
    const report = clientConfigs.find('claude-code')!.run('default')._unsafeUnwrap();
    expect(report.warnings).toEqual([expect.stringContaining('does not contain a JSON object at the root')]);
    expect(report.lines).toHaveLength(2);
  });

  it('a file it cannot read is a read_failed error, not an exception', async () => {
    const { clientConfigs, log, error } = await withHome();
    mkdirSync(join(home, '.claude', 'mcp.json'), { recursive: true }); // a directory where the file should be
    const failure = clientConfigs.find('claude-code')!.run('default')._unsafeUnwrapErr();
    expect(failure).toMatchObject({
      code: ClientConfigFailureCode.enum.read_failed,
      path: join(home, '.claude', 'mcp.json'),
    });
    expect(failure.reason).toMatch(/EISDIR/);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a file it cannot write is a write_failed error that still carries what was raised while reading', async () => {
    const { clientConfigs } = await withHome();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const file = join(home, '.claude', 'mcp.json');
    writeFileSync(file, '[]', 'utf8');
    chmodSync(file, 0o444);
    const failure = clientConfigs.find('claude-code')!.run('default')._unsafeUnwrapErr();
    expect(failure).toMatchObject({ code: ClientConfigFailureCode.enum.write_failed, path: file });
    expect(failure.warnings).toEqual([expect.stringContaining('does not contain a JSON object at the root')]);
  });

  it('codex escapes the demo path, so a Windows path or a quote still pastes as valid JSON', async () => {
    const { clientConfigs } = await withHome();
    const path = 'C:\\Users\\al"ice\\.patty\\demo.db';
    const [snippet] = clientConfigs.find('codex')!.addDemo(path)._unsafeUnwrap().lines;
    const env = /"env": (\{.*\})/.exec(snippet ?? '')?.[1] ?? '';
    expect(JSON.parse(env)).toMatchObject({ DB_PATH: path });
  });

  it('codex describes the snippet as one line of report, and writes no file', async () => {
    const { clientConfigs } = await withHome();
    const report = clientConfigs.find('codex')!.run('work')._unsafeUnwrap();
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toContain('"env": { "PATTY_PROFILE": "work" }');
  });
});
