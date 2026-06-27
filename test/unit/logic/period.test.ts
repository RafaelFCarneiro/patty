import { describe, expect, it } from 'vitest'
import { assertHasPeriodOrRange, hasPeriod, hasDateRange, periodRange } from '../../../src/logic/period.js'

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
})
