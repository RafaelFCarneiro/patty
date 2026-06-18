import { describe, expect, it } from 'vitest'
import { TransactionStatus } from '../../../src/models/transaction.js'
import { defaultStatusFor } from '../../../src/logic/transaction.js'

const { pending, effective } = TransactionStatus.enum

describe('defaultStatusFor', () => {
  it('returns pending for a future date', () => {
    expect(defaultStatusFor('2030-01-01', '2026-06-18')).toBe(pending)
  })

  it('returns effective for today', () => {
    expect(defaultStatusFor('2026-06-18', '2026-06-18')).toBe(effective)
  })

  it('returns effective for a past date', () => {
    expect(defaultStatusFor('2020-03-15', '2026-06-18')).toBe(effective)
  })

  it('boundary: tomorrow is pending', () => {
    expect(defaultStatusFor('2026-06-19', '2026-06-18')).toBe(pending)
  })

  it('boundary: yesterday is effective', () => {
    expect(defaultStatusFor('2026-06-17', '2026-06-18')).toBe(effective)
  })
})
