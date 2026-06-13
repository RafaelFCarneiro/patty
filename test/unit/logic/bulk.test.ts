import { describe, expect, it } from 'vitest'
import { deriveIdempotencyKey, needsReview } from '../../../src/logic/bulk.js'

describe('deriveIdempotencyKey', () => {
  it('is stable for the same statement line', () => {
    const item = { date: '2026-06-09', description: 'PAG*UberTrip 99-SP', amount: 32.5 }
    expect(deriveIdempotencyKey(item)).toBe('2026-06-09-ubertrip-sp-32.50')
    expect(deriveIdempotencyKey(item)).toBe(deriveIdempotencyKey({ ...item }))
  })

  it('differs when amount differs', () => {
    const a = { date: '2026-06-09', description: 'IFOOD', amount: 30 }
    expect(deriveIdempotencyKey(a)).not.toBe(deriveIdempotencyKey({ ...a, amount: 31 }))
  })
})

describe('needsReview', () => {
  it('flags unclassified and low-confidence', () => {
    expect(needsReview({ method: 'none', confidence: 0 })).toBe(true)
    expect(needsReview({ method: 'graph', confidence: 0.55 })).toBe(true)
    expect(needsReview({ method: 'rule', confidence: 0.8 })).toBe(false)
    expect(needsReview({ method: 'user', confidence: 1 })).toBe(false)
  })
})
