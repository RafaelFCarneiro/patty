import { describe, expect, it } from 'vitest'
import { nextDue, recurringIdempotencyKey } from './recurring.js'

describe('nextDue', () => {
  it('advances monthly, clamping short months', () => {
    expect(nextDue('2026-06-15', 'monthly')).toBe('2026-07-15')
    expect(nextDue('2026-01-31', 'monthly')).toBe('2026-02-28')
    expect(nextDue('2026-12-10', 'monthly')).toBe('2027-01-10')
  })

  it('advances weekly across month boundaries', () => {
    expect(nextDue('2026-06-28', 'weekly')).toBe('2026-07-05')
  })

  it('advances yearly, clamping Feb 29', () => {
    expect(nextDue('2028-02-29', 'yearly')).toBe('2029-02-28')
    expect(nextDue('2026-03-01', 'yearly')).toBe('2027-03-01')
  })
})

describe('recurringIdempotencyKey', () => {
  it('is stable per rule + due date', () => {
    expect(recurringIdempotencyKey('r1', '2026-06-01')).toBe('rec-r1-2026-06-01')
  })
})
