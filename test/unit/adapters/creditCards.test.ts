import { describe, expect, it } from 'vitest'
import * as wireInCreditCards from '../../../src/wire/in/creditCards.js'
import * as creditCardAdapters from '../../../src/adapters/creditCards.js'

describe('wireInToModel', () => {
  it('applies USD currency default when omitted', () => {
    const parsed = wireInCreditCards.CreateCreditCardSchema.parse({ name: 'Nubank', closingDay: 2, dueDay: 10 })
    expect(creditCardAdapters.wireInToModel(parsed)).toEqual({
      name: 'Nubank',
      currency: 'USD',
      closingDay: 2,
      dueDay: 10,
      limit: undefined,
    })
  })

  it('preserves explicit currency and optional limit when provided', () => {
    const parsed = wireInCreditCards.CreateCreditCardSchema.parse({
      name: 'USD Card',
      currency: 'USD',
      closingDay: 5,
      dueDay: 15,
      limit: 5000,
    })
    expect(creditCardAdapters.wireInToModel(parsed)).toEqual({
      name: 'USD Card',
      currency: 'USD',
      closingDay: 5,
      dueDay: 15,
      limit: 5000,
    })
  })

  it('requires name, closingDay, and dueDay', () => {
    expect(() => wireInCreditCards.CreateCreditCardSchema.parse({})).toThrow()
    expect(() => wireInCreditCards.CreateCreditCardSchema.parse({ name: 'X' })).toThrow()
  })
})
