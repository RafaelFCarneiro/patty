import { describe, expect, it } from 'vitest';
import { DEMO_ENV_ON, DEMO_ENV_VAR, DEMO_PORT, DEMO_SERVER_NAME } from '../../../../src/models/demo/core.js';
import {
  mergeMcpServersKey,
  mergeServersKey,
  resolveConfigObject,
  STDIO_ENTRY,
  VSCODE_ENTRY,
  withDemo,
  withoutServer,
  withProfile,
} from '../../../../src/diplomat/client-config/merge.js';

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

describe('withProfile (ADR-034 §5.2)', () => {
  it('leaves an ordinary install’s entry exactly as it always was', () => {
    expect(withProfile(STDIO_ENTRY, 'default')).toBe(STDIO_ENTRY);
    expect(withProfile(VSCODE_ENTRY, 'default')).toBe(VSCODE_ENTRY);
  });

  it('adds FINTRACK_PROFILE to the entry’s env only for a non-default profile, keeping the rest', () => {
    expect(withProfile(STDIO_ENTRY, 'work')).toEqual({ ...STDIO_ENTRY, env: { FINTRACK_PROFILE: 'work' } });
    expect(withProfile(VSCODE_ENTRY, 'work')).toEqual({ ...VSCODE_ENTRY, env: { FINTRACK_PROFILE: 'work' } });
  });
});

describe('the demo entry', () => {
  it('merges under its own name and leaves the fintrack entry alone', () => {
    const existing = { mcpServers: { fintrack: { command: 'real' } } };
    const demo = withDemo(STDIO_ENTRY, '/home/x/.fintrack/demo.db');
    expect(mergeMcpServersKey(existing, demo, DEMO_SERVER_NAME).mcpServers).toEqual({
      fintrack: { command: 'real' },
      [DEMO_SERVER_NAME]: demo,
    });
    expect(mergeServersKey({}, demo, DEMO_SERVER_NAME)).toEqual({ servers: { [DEMO_SERVER_NAME]: demo } });
  });

  it('runs the same server against the demo database, port and key switch', () => {
    expect(withDemo(VSCODE_ENTRY, '/home/x/.fintrack/demo.db')).toEqual({
      ...VSCODE_ENTRY,
      env: { DB_PATH: '/home/x/.fintrack/demo.db', PORT: String(DEMO_PORT), [DEMO_ENV_VAR]: DEMO_ENV_ON },
    });
  });
});

describe('withoutServer', () => {
  it('drops only the named server and keeps every other key', () => {
    const existing = { theme: 'dark', mcpServers: { a: { command: 'a' }, b: { command: 'b' } } };
    expect(withoutServer(existing, 'mcpServers', 'a')).toEqual({ theme: 'dark', mcpServers: { b: { command: 'b' } } });
    expect(existing.mcpServers).toHaveProperty('a');
  });

  it.each([
    ['no servers key', {}],
    ['a servers key that is not an object', { mcpServers: [] }],
    ['no such server', { mcpServers: { other: {} } }],
  ])('is null when there is nothing to remove (%s)', (_label, existing) => {
    expect(withoutServer(existing, 'mcpServers', 'a')).toBeNull();
  });
});
