import { describe, expect, it } from 'vitest'
import * as wireInRecurring from '../wire/in/recurring.js'
import * as recurringAdapters from './recurring.js'

describe('wireInToModel', () => {
  it('passes all required fields through unchanged', () => {
    const parsed = wireInRecurring.CreateRecurringInput.parse({
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
    const parsed = wireInRecurring.CreateRecurringInput.parse({
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
