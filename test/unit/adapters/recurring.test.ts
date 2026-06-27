import { describe, expect, it } from 'vitest'
import * as wireInRecurring from '../../../src/wire/in/recurring.js'
import * as recurringAdapters from '../../../src/adapters/recurring.js'

describe('wireInToModel', () => {
  it('passes all required fields through unchanged', () => {
    const parsed = wireInRecurring.CreateRecurringSchema.parse({
      description: 'Spotify',
      amount: 21.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-01-01',
    })
    expect(recurringAdapters.wireInToModel(parsed)).toMatchObject({
      description: 'Spotify',
      amount: 21.9,
      type: 'expense',
      period: 'monthly',
      startDate: '2026-01-01',
    })
  })

  it('preserves optional fields when provided', () => {
    const parsed = wireInRecurring.CreateRecurringSchema.parse({
      description: 'Salário',
      amount: 5000,
      type: 'income',
      period: 'monthly',
      startDate: '2026-06-01',
      account: 'acc-nubank',
      category: 'cat-salario',
      currency: 'USD',
    })
    expect(recurringAdapters.wireInToModel(parsed)).toMatchObject({
      account: 'acc-nubank',
      category: 'cat-salario',
      currency: 'USD',
    })
  })
})
