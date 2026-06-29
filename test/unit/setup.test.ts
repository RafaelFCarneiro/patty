import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mergeMcpServersKey,
  mergeServersKey,
  readJsonOrEmpty,
  resolveConfigObject,
  STDIO_ENTRY,
  VSCODE_ENTRY,
} from '../../src/setup.js'

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

  it('treats an array mcpServers value as empty', () => {
    const existing = { mcpServers: [] }
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

  it('treats an array servers value as empty', () => {
    const existing = { servers: [] }
    const result = mergeServersKey(existing, { ...VSCODE_ENTRY })
    expect(result).toEqual({ servers: { fintrack: VSCODE_ENTRY } })
  })
})

describe('resolveConfigObject', () => {
  it('returns plain objects', () => {
    const config = { mcpServers: {} }
    expect(resolveConfigObject(config)).toBe(config)
  })

  it.each([null, [], 'config'])('rejects non-object config roots: %j', (value) => {
    expect(resolveConfigObject(value)).toBeNull()
  })
})

describe('readJsonOrEmpty', () => {
  let tempDir = ''

  afterEach(() => {
    vi.restoreAllMocks()
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns an empty object when the file does not exist', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'))
    expect(readJsonOrEmpty(join(tempDir, 'missing.json'))).toEqual({})
  })

  it('reports the underlying file read failure message', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fintrack-setup-'))
    const configPath = join(tempDir, 'config.json')
    mkdirSync(configPath)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`)
    }) as typeof process.exit)

    expect(() => readJsonOrEmpty(configPath)).toThrow('process.exit:1')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(
      new RegExp(`^fintrack setup: failed to read ${escapeForRegExp(configPath)}: EISDIR:`),
    )
  })
})

describe('STDIO_ENTRY', () => {
  it('uses npx with the published package', () => {
    expect(STDIO_ENTRY.command).toBe('npx')
    expect(STDIO_ENTRY.args).toEqual(['-y', '@rafaelfcarneiro/fintrack@latest'])
  })
})

describe('VSCODE_ENTRY', () => {
  it('includes type:stdio required by VS Code', () => {
    expect(VSCODE_ENTRY.type).toBe('stdio')
    expect(VSCODE_ENTRY.command).toBe('npx')
  })
})
