import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientConfigFailureCode } from '../../../../src/models/client-config.js';
import { parse as parseJsonc } from 'jsonc-parser';
import { DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT, DEMO_SERVER_NAME } from '../../../../src/models/demo/core.js';
import { PACKAGE_SPEC } from '../../../../src/models/package.js';
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

describe('OpenCode (JSONC-safe)', () => {
  let home = '';
  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const directory = () => join(home, '.config', 'opencode');
  const jsonFile = () => join(directory(), 'opencode.json');
  const jsoncFile = () => join(directory(), 'opencode.jsonc');
  const seed = (file: string, text: string) => {
    mkdirSync(directory(), { recursive: true });
    writeFileSync(file, text, 'utf8');
  };
  const written = (file: string): any => parseJsonc(readFileSync(file, 'utf8'));

  const opencode = async () => {
    home = mkdtempSync(join(tmpdir(), 'patty-opencode-'));
    vi.resetModules();
    vi.doMock('node:os', () => ({ homedir: () => home }));
    const { clientConfigs } = await import('../../../../src/diplomat/client-config/clients.js');
    return clientConfigs.find('opencode')!;
  };

  const ENTRY = { type: 'local', command: ['npx', '-y', PACKAGE_SPEC] };
  const COMMENTED = `{
  // my theme
  "theme": "dark", /* keep */
  "mcp": {
    "servers": {
      "other": {
        "type": "local",
        "command": ["x"],
      },
    },
  },
}
`;

  it('creates opencode.json with the entry when no file exists', async () => {
    const client = await opencode();
    const report = client.run('default')._unsafeUnwrap();
    expect(report.lines).toEqual([
      `  Updated: ${jsonFile()}`,
      '  Verify with: opencode mcp list   (or /mcps inside OpenCode)',
    ]);
    expect(written(jsonFile())).toEqual({ mcp: { servers: { patty: ENTRY } } });
  });

  it('is labelled OpenCode', async () => {
    const client = await opencode();
    expect(client.label).toBe('OpenCode');
  });

  it('adds the entry to a JSONC file, keeping comments, trailing commas and other keys', async () => {
    const client = await opencode();
    seed(jsonFile(), COMMENTED);
    client.run('default')._unsafeUnwrap();
    const text = readFileSync(jsonFile(), 'utf8');
    expect(text).toContain('// my theme');
    expect(text).toContain('/* keep */');
    expect(text).toContain('"command": ["x"],');
    expect(written(jsonFile())).toMatchObject({
      theme: 'dark',
      mcp: { servers: { other: { type: 'local', command: ['x'] }, patty: ENTRY } },
    });
  });

  it('replaces an existing patty entry', async () => {
    const client = await opencode();
    seed(jsonFile(), '{ "mcp": { "servers": { "patty": { "type": "local", "command": ["old"] } } } }');
    client.run('default')._unsafeUnwrap();
    expect(written(jsonFile()).mcp.servers.patty).toEqual(ENTRY);
  });

  it('puts the profile under environment, not env', async () => {
    const client = await opencode();
    client.run('work')._unsafeUnwrap();
    expect(written(jsonFile()).mcp.servers.patty).toEqual({ ...ENTRY, environment: { PATTY_PROFILE: 'work' } });
  });

  it('prefers opencode.jsonc over opencode.json', async () => {
    const client = await opencode();
    seed(jsonFile(), '{}');
    seed(jsoncFile(), '// mine\n{}\n');
    client.run('default')._unsafeUnwrap();
    expect(readFileSync(jsoncFile(), 'utf8')).toContain('// mine');
    expect(written(jsoncFile()).mcp.servers.patty).toEqual(ENTRY);
    expect(readFileSync(jsonFile(), 'utf8')).toBe('{}');
  });

  it('--demo adds patty-demo with the demo environment and leaves patty untouched', async () => {
    const client = await opencode();
    seed(jsoncFile(), COMMENTED);
    client.run('default')._unsafeUnwrap();
    const before = written(jsoncFile()).mcp.servers.patty;
    client.addDemo('/tmp/demo.db')._unsafeUnwrap();
    const servers = written(jsoncFile()).mcp.servers;
    expect(servers.patty).toEqual(before);
    expect(servers[DEMO_SERVER_NAME]).toEqual({
      ...ENTRY,
      environment: { DB_PATH: '/tmp/demo.db', PORT: String(DEMO_PORT), [DEMO_ENV_VAR]: DEMO_ENV_ON },
    });
    expect(readFileSync(jsoncFile(), 'utf8')).toContain('// my theme');
  });

  it('--remove-demo removes only patty-demo and keeps comments', async () => {
    const client = await opencode();
    seed(jsoncFile(), COMMENTED);
    client.run('default')._unsafeUnwrap();
    client.addDemo('/tmp/demo.db')._unsafeUnwrap();
    const report = client.removeDemo()._unsafeUnwrap();
    expect(report.lines[0]).toBe(`  Removed ${DEMO_SERVER_NAME} from ${jsoncFile()}`);
    const servers = written(jsoncFile()).mcp.servers;
    expect(Object.keys(servers).sort()).toEqual(['other', 'patty']);
    expect(readFileSync(jsoncFile(), 'utf8')).toContain('// my theme');
  });

  it('--remove-demo says there is nothing to remove for a missing file or a missing entry', async () => {
    const client = await opencode();
    expect(client.removeDemo()._unsafeUnwrap().lines[0]).toMatch(/^ {2}No demo entry to remove: .* does not exist$/);
    seed(jsonFile(), COMMENTED);
    expect(client.removeDemo()._unsafeUnwrap().lines[0]).toBe(`  No ${DEMO_SERVER_NAME} entry in ${jsonFile()}`);
    expect(readFileSync(jsonFile(), 'utf8')).toBe(COMMENTED);
  });

  it.each([
    ['an unparsable file', '{ "mcp": { // never closed'],
    ['an array at the root', '[]'],
    ['a V1 layout', '{ // legacy\n "mcp": { "other": { "type": "local", "command": ["x"] } } }'],
    ['a servers key that is not an object', '{ "mcp": { "servers": "nope" } }'],
  ])('refuses %s and leaves the file byte-identical, for every operation', async (_name, content) => {
    const client = await opencode();
    seed(jsonFile(), content);
    const operations = [
      () => client.run('default'),
      () => client.addDemo('/tmp/demo.db'),
      () => client.removeDemo(),
    ];
    operations.forEach((operation) => {
      const failure = operation()._unsafeUnwrapErr();
      expect(failure).toMatchObject({ code: ClientConfigFailureCode.enum.read_failed, path: jsonFile() });
      expect(readFileSync(jsonFile(), 'utf8')).toBe(content);
    });
  });

  it.each([
    ['an empty file', '', []],
    ['a file of only comments', '// mine\n', ['// mine\n']],
    ['a CRLF file', '{\r\n  "theme": "dark"\r\n}\r\n', ['"theme": "dark",\r\n']],
    ['a file with a byte-order mark', '\uFEFF{"theme":"dark"}', []],
  ])('writes the entry into %s', async (_name, content, kept) => {
    const client = await opencode();
    seed(jsonFile(), content);
    client.run('default')._unsafeUnwrap();
    const text = readFileSync(jsonFile(), 'utf8');
    expect(written(jsonFile()).mcp.servers.patty).toEqual(ENTRY);
    kept.forEach((fragment) => expect(text).toContain(fragment));
  });

  it('keeps every line break CRLF in a CRLF file', async () => {
    const client = await opencode();
    seed(jsonFile(), '{\r\n  "theme": "dark"\r\n}\r\n');
    client.run('default')._unsafeUnwrap();
    expect(readFileSync(jsonFile(), 'utf8')).not.toMatch(/(?<!\r)\n/);
  });

  it('reports a config path that is a directory as a read failure', async () => {
    const client = await opencode();
    mkdirSync(jsonFile(), { recursive: true });
    const failure = client.run('default')._unsafeUnwrapErr();
    expect(failure.code).toBe(ClientConfigFailureCode.enum.read_failed);
    expect(failure.reason).toMatch(/^EISDIR:/);
  });

  it('reports a write failure with the path', async () => {
    const client = await opencode();
    seed(jsonFile(), '{}');
    chmodSync(jsonFile(), 0o444);
    const result = client.run('default');
    chmodSync(jsonFile(), 0o644);
    if (process.getuid?.() === 0) return; // root writes anyway
    expect(result._unsafeUnwrapErr()).toMatchObject({
      code: ClientConfigFailureCode.enum.write_failed,
      path: jsonFile(),
    });
  });

  it('points a V1 layout to the migration docs', async () => {
    const client = await opencode();
    seed(jsonFile(), '{ "mcp": { "other": {} } }');
    expect(client.run('default')._unsafeUnwrapErr().reason).toContain('Migrate from V1');
  });
});
