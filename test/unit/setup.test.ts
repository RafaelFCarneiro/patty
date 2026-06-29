import { describe, expect, it } from 'vitest'
import { mergeMcpServersKey, mergeServersKey, STDIO_ENTRY, VSCODE_ENTRY } from '../../src/setup.js'

describe('mergeMcpServersKey', () => {
  it('adds fintrack entry to an empty config', () => {
    const result = mergeMcpServersKey({}, { ...STDIO_ENTRY })
    expect(result).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } })
  })

  it('preserves existing mcpServers entries', () => {
    const existing = { mcpServers: { other: { command: 'other-cmd', args: [] } } }
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY })
    expect(result.mcpServers).toEqual({
      other: { command: 'other-cmd', args: [] },
      fintrack: STDIO_ENTRY,
    })
  })

  it('overwrites an existing fintrack entry (idempotent)', () => {
    const existing = { mcpServers: { fintrack: { command: 'old', args: [] } } }
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY })
    expect((result.mcpServers as Record<string, unknown>)['fintrack']).toEqual(STDIO_ENTRY)
  })

  it('preserves top-level keys unrelated to mcpServers', () => {
    const existing = { someAppPreference: true, mcpServers: {} }
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY })
    expect(result['someAppPreference']).toBe(true)
  })

  it('treats a non-object mcpServers value as empty', () => {
    const existing = { mcpServers: 'corrupt' }
    const result = mergeMcpServersKey(existing, { ...STDIO_ENTRY })
    expect(result).toEqual({ mcpServers: { fintrack: STDIO_ENTRY } })
  })
})

describe('mergeServersKey', () => {
  it('adds fintrack entry under servers key (VS Code shape)', () => {
    const result = mergeServersKey({}, { ...VSCODE_ENTRY })
    expect(result).toEqual({ servers: { fintrack: VSCODE_ENTRY } })
  })

  it('preserves existing servers entries', () => {
    const existing = { servers: { other: { type: 'stdio', command: 'x', args: [] } } }
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY })
    expect(result.servers).toEqual({
      other: { type: 'stdio', command: 'x', args: [] },
      fintrack: VSCODE_ENTRY,
    })
  })

  it('overwrites an existing fintrack entry (idempotent)', () => {
    const existing = { servers: { fintrack: { type: 'stdio', command: 'old', args: [] } } }
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY })
    expect((result.servers as Record<string, unknown>)['fintrack']).toEqual(VSCODE_ENTRY)
  })

  it('preserves top-level keys unrelated to servers', () => {
    const existing = { inputs: [], servers: {} }
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY })
    expect(result['inputs']).toEqual([])
  })

  it('treats a non-object servers value as empty', () => {
    const existing = { servers: null }
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY })
    expect(result).toEqual({ servers: { fintrack: VSCODE_ENTRY } })
  })
})

describe('STDIO_ENTRY', () => {
  it('uses npx with the published package', () => {
    expect(STDIO_ENTRY.command).toBe('npx')
    expect(STDIO_ENTRY.args).toContain('@rafaelfcarneiro/fintrack')
  })
})

describe('VSCODE_ENTRY', () => {
  it('includes type:stdio required by VS Code', () => {
    expect(VSCODE_ENTRY.type).toBe('stdio')
    expect(VSCODE_ENTRY.command).toBe('npx')
  })
})
