import { describe, expect, it } from 'vitest'
import { toMatchQuery } from '../../../../src/diplomat/db/fts.js'

describe('toMatchQuery', () => {
  it('quotes a single token', () => {
    expect(toMatchQuery('uber')).toBe('"uber"')
  })

  it('quotes each whitespace-separated token (implicit AND)', () => {
    expect(toMatchQuery('uber trip')).toBe('"uber" "trip"')
  })

  it('neutralises FTS5 operators and special characters', () => {
    // Without quoting these would be parsed as operators/columns and throw.
    expect(toMatchQuery('uber-trip')).toBe('"uber-trip"')
    expect(toMatchQuery('a OR b')).toBe('"a" "OR" "b"')
    expect(toMatchQuery('price:10')).toBe('"price:10"')
  })

  it('escapes embedded double quotes', () => {
    expect(toMatchQuery('say "hi"')).toBe('"say" """hi"""')
  })

  it('collapses surrounding and repeated whitespace', () => {
    expect(toMatchQuery('  uber   trip  ')).toBe('"uber" "trip"')
  })

  it('returns null when there is no searchable token', () => {
    expect(toMatchQuery('')).toBeNull()
    expect(toMatchQuery('   ')).toBeNull()
  })
})
