import { describe, expect, it } from 'vitest'
import {
  assertHasPeriodOrRange, hasPeriod, hasDateRange, periodRange, resolveDateRange,
} from '../../../src/logic/period.js'

describe('periodRange', () => {
  it('builds half-open month range', () => {
    expect(periodRange({ month: 6, year: 2026 })).toEqual({ from: '2026-06-01', to: '2026-07-01' })
  })

  it('rolls over December', () => {
    expect(periodRange({ month: 12, year: 2026 })).toEqual({ from: '2026-12-01', to: '2027-01-01' })
  })
})

describe('hasPeriod', () => {
  it('true when month and year present', () => {
    expect(hasPeriod({ month: 6, year: 2026 })).toBe(true)
  })

  it('false when month missing', () => {
    expect(hasPeriod({ year: 2026 })).toBe(false)
  })

  it('false when both missing', () => {
    expect(hasPeriod({})).toBe(false)
  })
})

describe('hasDateRange', () => {
  it('true when from provided', () => {
    expect(hasDateRange({ from: '2026-01-01' })).toBe(true)
  })

  it('true when to provided', () => {
    expect(hasDateRange({ to: '2026-12-31' })).toBe(true)
  })

  it('false when neither', () => {
    expect(hasDateRange({})).toBe(false)
  })
})

describe('assertHasPeriodOrRange', () => {
  it('true with month+year', () => {
    expect(assertHasPeriodOrRange({ month: 6, year: 2026 })).toBe(true)
  })

  it('true with from/to', () => {
    expect(assertHasPeriodOrRange({ from: '2026-01-01', to: '2026-06-30' })).toBe(true)
  })

  it('false with nothing', () => {
    expect(assertHasPeriodOrRange({})).toBe(false)
  })

  it('false with null month and year', () => {
    expect(assertHasPeriodOrRange({ month: null, year: null })).toBe(false)
  })

  it('false with undefined month and year', () => {
    expect(assertHasPeriodOrRange({ month: undefined, year: undefined })).toBe(false)
  })

  it('true with from only (null to)', () => {
    expect(assertHasPeriodOrRange({ from: '2026-01-01', to: null })).toBe(true)
  })
})

describe('resolveDateRange', () => {
  it('uses month+year period when both provided', () => {
    const result = resolveDateRange({ month: 6, year: 2026 })
    expect(result).toEqual({ from: '2026-06-01', to: '2026-07-01' })
  })

  it('falls back to from/to when month+year absent', () => {
    const result = resolveDateRange({ from: '2026-03-01', to: '2026-03-31' })
    expect(result).toEqual({ from: '2026-03-01', to: '2026-03-31' })
  })

  it('returns null for both when nothing provided', () => {
    const result = resolveDateRange({})
    expect(result).toEqual({ from: null, to: null })
  })

  it('handles null from/to gracefully', () => {
    const result = resolveDateRange({ from: null, to: null })
    expect(result).toEqual({ from: null, to: null })
  })

  it('handles undefined from/to gracefully', () => {
    const result = resolveDateRange({ from: undefined, to: undefined })
    expect(result).toEqual({ from: null, to: null })
  })

  it('month+year takes priority over from/to', () => {
    const result = resolveDateRange({ month: 1, year: 2026, from: '2025-12-01', to: '2025-12-31' })
    expect(result).toEqual({ from: '2026-01-01', to: '2026-02-01' })
  })

  it('partial from without to returns from with null to', () => {
    const result = resolveDateRange({ from: '2026-06-01' })
    expect(result).toEqual({ from: '2026-06-01', to: null })
  })
})
