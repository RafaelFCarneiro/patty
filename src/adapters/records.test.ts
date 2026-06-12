import { describe, expect, it } from 'vitest'
import { toAccount, toCategory, toTransaction } from './records.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('toAccount', () => {
  it('decodes node + currency column, defaulting initialBalance for legacy nodes', () => {
    const account = toAccount({
      a: node({ id: 'acc-1', name: 'Nubank', type: 'checking' }),
      currency: 'BRL',
    })
    expect(account).toEqual({
      id: 'acc-1',
      name: 'Nubank',
      type: 'checking',
      currency: 'BRL',
      initialBalance: 0,
    })
  })

  it('rejects invalid records (decode at the boundary)', () => {
    expect(() => toAccount({ a: node({ id: 'x', name: '', type: 'checking' }), currency: 'BRL' })).toThrow()
  })
})

describe('toCategory', () => {
  it('decodes the category node', () => {
    expect(toCategory({ c: node({ id: 'cat-1', name: 'Transporte', kind: 'expense' }) })).toEqual({
      id: 'cat-1',
      name: 'Transporte',
      kind: 'expense',
    })
  })
})

describe('toTransaction', () => {
  const txNode = node({
    id: 'tx-1',
    description: 'Uber',
    amount: 32.5,
    type: 'expense',
    date: '2026-06-09',
    currency: 'BRL',
    source: 'mcp',
    idempotencyKey: 'k1',
    classificationMethod: 'rule',
    confidence: 0.8,
  })

  it('nests flat db classification back into the model', () => {
    const tx = toTransaction({
      t: txNode,
      accountId: 'acc-1',
      accountName: 'Nubank',
      categoryId: 'cat-transporte',
      categoryName: 'Transporte',
      merchant: 'uber',
    })
    expect(tx.classification).toEqual({ method: 'rule', confidence: 0.8 })
    expect(tx.accountName).toBe('Nubank')
    expect(tx.merchant).toBe('uber')
  })

  it('maps null relation columns to undefined optionals', () => {
    const tx = toTransaction({ t: txNode, accountId: null, categoryName: null, merchant: null })
    expect(tx.accountId).toBeUndefined()
    expect(tx.toAccountId).toBeUndefined()
    expect(tx.rawInput).toBeUndefined()
  })

  it('round-trips a transfer with both account sides', () => {
    const tx = toTransaction({
      t: node({ ...txNode.properties, type: 'transfer', classificationMethod: 'none', confidence: 0 }),
      accountId: 'acc-1',
      accountName: 'Nubank',
      toAccountId: 'acc-2',
      toAccountName: 'Poupança',
    })
    expect(tx.type).toBe('transfer')
    expect(tx.toAccountName).toBe('Poupança')
  })
})
