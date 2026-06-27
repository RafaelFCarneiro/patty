import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PeriodSchema } from '../../../src/models/common.js'
import { coerceToNumber } from '../../../src/wire/coerce.js'

const CoercedPeriod = PeriodSchema.extend({
  month: z.preprocess(coerceToNumber, PeriodSchema.shape.month),
  year: z.preprocess(coerceToNumber, PeriodSchema.shape.year),
})

describe('PeriodSchema with coercion (HTTP query params)', () => {
  it('accepts valid string month/year', () => {
    expect(CoercedPeriod.parse({ month: '6', year: '2026' })).toEqual({ month: 6, year: 2026 })
  })

  it('rejects month below range', () => {
    expect(() => CoercedPeriod.parse({ month: '0', year: '2026' })).toThrow()
  })

  it('rejects month above range', () => {
    expect(() => CoercedPeriod.parse({ month: '13', year: '2026' })).toThrow()
  })

  it('rejects non-integer month', () => {
    expect(() => CoercedPeriod.parse({ month: '1.5', year: '2026' })).toThrow()
  })

  it('rejects year below range', () => {
    expect(() => CoercedPeriod.parse({ month: '6', year: '1999' })).toThrow()
  })
})
