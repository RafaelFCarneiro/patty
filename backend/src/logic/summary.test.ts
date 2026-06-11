import { describe, expect, it } from 'vitest'
import { summarize } from './summary.js'

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
})
