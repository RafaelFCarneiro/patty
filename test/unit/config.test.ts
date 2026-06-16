import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  delete process.env['FINTRACK_DB_KEY']
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('loadConfig', () => {
  it('accepts a 64-character hex FINTRACK_DB_KEY', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(64)
    expect(() => loadConfig()).not.toThrow()
  })

  it('accepts uppercase hex characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'A'.repeat(64)
    expect(() => loadConfig()).not.toThrow()
  })

  it('rejects a key shorter than 64 characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(63)
    expect(() => loadConfig()).toThrow()
  })

  it('rejects a key longer than 64 characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'a'.repeat(65)
    expect(() => loadConfig()).toThrow()
  })

  it('rejects non-hex characters', () => {
    process.env['FINTRACK_DB_KEY'] = 'g'.repeat(64)
    expect(() => loadConfig()).toThrow()
  })

  it('allows FINTRACK_DB_KEY to be omitted (falls back to keychain)', () => {
    expect(() => loadConfig()).not.toThrow()
  })
})
