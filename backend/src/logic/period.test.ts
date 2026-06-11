import { describe, expect, it } from 'vitest'
import { periodRange } from './period.js'

describe('periodRange', () => {
  it('builds half-open month range', () => {
    expect(periodRange({ month: 6, year: 2026 })).toEqual({ from: '2026-06-01', to: '2026-07-01' })
  })

  it('rolls over December', () => {
    expect(periodRange({ month: 12, year: 2026 })).toEqual({ from: '2026-12-01', to: '2027-01-01' })
  })
})
