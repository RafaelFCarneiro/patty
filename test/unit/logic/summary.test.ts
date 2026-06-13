import { describe, expect, it } from 'vitest'
import { summarize } from '../../../src/logic/summary.js'

describe('summarize', () => {
  it('groups strictly per currency — never mixes', () => {
    const out = summarize([
      { currency: 'BRL', type: 'expense', category: 'Transporte', total: 100, count: 4 },
      { currency: 'BRL', type: 'income', category: 'Salário', total: 5000, count: 1 },
      { currency: 'USD', type: 'expense', category: 'Assinaturas', total: 20, count: 2 },
    ])
    expect(out).toHaveLength(2)
    const brl = out.find((s) => s.currency === 'BRL')!
    expect(brl.balance).toBe(4900)
    const usd = out.find((s) => s.currency === 'USD')!
    expect(usd).toMatchObject({ income: 0, expenses: 20, balance: -20 })
  })

  it('labels null category and sorts by total desc', () => {
    const out = summarize([
      { currency: 'BRL', type: 'expense', category: null, total: 10, count: 1 },
      { currency: 'BRL', type: 'expense', category: 'Lazer', total: 200, count: 2 },
    ])
    expect(out[0]!.byCategory.map((c) => c.category)).toEqual(['Lazer', 'Sem categoria'])
  })

  it('rounds monetary totals to 2 decimal places', () => {
    const out = summarize([
      { currency: 'BRL', type: 'income', category: 'Renda Extra', total: 0.1, count: 1 },
      { currency: 'BRL', type: 'income', category: 'Renda Extra', total: 0.2, count: 1 },
      { currency: 'BRL', type: 'expense', category: 'Transporte', total: 0.05, count: 1 },
    ])

    expect(out).toHaveLength(1)
    expect(out[0]!.income).toBe(0.3)
    expect(out[0]!.expenses).toBe(0.05)
    expect(out[0]!.balance).toBe(0.25)
  })
})
