import { describe, expect, it } from 'vitest'
import { pickClassification, weightToConfidence } from '../../../src/logic/classify.js'

describe('weightToConfidence', () => {
  it('is monotonic and saturating', () => {
    expect(weightToConfidence(1)).toBeCloseTo(0.6)
    expect(weightToConfidence(3)).toBeCloseTo(0.8)
    expect(weightToConfidence(100)).toBe(0.95)
    expect(weightToConfidence(0)).toBeCloseTo(0.5)
  })
})

describe('pickClassification', () => {
  it('returns none with zero confidence when no match', () => {
    expect(pickClassification([])).toEqual({ method: 'none', confidence: 0 })
  })

  it('picks the strongest edge', () => {
    const out = pickClassification([
      { merchantKey: 'uber', categoryId: 'cat-transporte', categoryName: 'Transporte', weight: 3, origin: 'rule' },
      { merchantKey: 'uber eats', categoryId: 'cat-alimentacao', categoryName: 'Alimentação', weight: 1, origin: 'graph' },
    ])
    expect(out.categoryId).toBe('cat-transporte')
    expect(out.method).toBe('rule')
    expect(out.confidence).toBeCloseTo(0.8)
  })
})
