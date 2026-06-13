import { describe, expect, it } from 'vitest'
import * as wireInCreditCards from '../../../src/wire/in/creditCards.js'
import * as creditCardAdapters from '../../../src/adapters/creditCards.js'

describe('wireInToModel', () => {
  it('applies BRL currency default when omitted', () => {
    const parsed = wireInCreditCards.CreateCreditCard.parse({ name: 'Nubank', closingDay: 2, dueDay: 10 })
    expect(creditCardAdapters.wireInToModel(parsed)).toEqual({
      name: 'Nubank',
      currency: 'BRL',
      closingDay: 2,
      dueDay: 10,
      limit: undefined,
    })
  })

  it('preserves explicit currency and optional limit when provided', () => {
    const parsed = wireInCreditCards.CreateCreditCard.parse({
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
})
