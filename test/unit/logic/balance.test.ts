import { describe, expect, it } from 'vitest'
import { computeBalance } from '../../../src/logic/balance.js'

describe('computeBalance', () => {
  it('combines initial balance, transactions, and transfers', () => {
    expect(
      computeBalance({ initialBalance: 1000, income: 5000, expenses: 1200, transfersIn: 300, transfersOut: 2000 }),
    ).toBe(3100)
  })

  it('handles empty account', () => {
    expect(
      computeBalance({ initialBalance: 0, income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 }),
    ).toBe(0)
  })

  it('can go negative', () => {
    expect(
      computeBalance({ initialBalance: 0, income: 0, expenses: 50, transfersIn: 0, transfersOut: 0 }),
    ).toBe(-50)
  })
})
