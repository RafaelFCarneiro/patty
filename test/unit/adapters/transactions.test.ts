import { describe, expect, it } from 'vitest'
import type { Transaction } from '../../../src/models/transaction.js'
import * as wireInTransactions from '../../../src/wire/in/transactions.js'
import * as transactionAdapters from '../../../src/adapters/transactions.js'

const draft: Transaction = {
  id: 'tx-1',
  description: 'Uber para o aeroporto',
  amount: 32.5,
  type: 'expense',
  date: '2026-06-09',
  currency: 'BRL',
  source: 'mcp',
  idempotencyKey: '2026-06-09-uber-32.50',
  classification: { method: 'rule', confidence: 0.8 },
  rawInput: 'paguei 32,50 de uber',
  refs: { accountId: 'acc-1', categoryId: 'cat-transporte', merchantKey: 'uber' },
}

describe('modelToDb', () => {
  it('flattens classification into node properties', () => {
    const { props } = transactionAdapters.modelToDb(draft)
    expect(props).toMatchObject({
      id: 'tx-1',
      classificationMethod: 'rule',
      confidence: 0.8,
      rawInput: 'paguei 32,50 de uber',
    })
    expect(props).not.toHaveProperty('classification')
    expect(props).not.toHaveProperty('refs')
  })

  it('converts missing optionals to explicit nulls for Cypher params', () => {
    const { props, refs } = transactionAdapters.modelToDb({
      ...draft,
      rawInput: undefined,
      refs: { accountId: 'acc-1', toAccountId: 'acc-2' },
    })
    expect(props.rawInput).toBeNull()
    expect(refs).toEqual({
      accountId: 'acc-1',
      toAccountId: 'acc-2',
      cardId: null,
      categoryId: null,
      merchantKey: null,
    })
  })

  it('supports transfer drafts (both account refs, no classification edge data)', () => {
    const { props, refs } = transactionAdapters.modelToDb({
      ...draft,
      type: 'transfer',
      classification: { method: 'none', confidence: 0 },
      refs: { accountId: 'acc-1', toAccountId: 'acc-2' },
    })
    expect(props.type).toBe('transfer')
    expect(props.classificationMethod).toBe('none')
    expect(refs.accountId).toBe('acc-1')
    expect(refs.toAccountId).toBe('acc-2')
  })
})

describe('patchToDb', () => {
  it('emits only provided fields — absent fields never reach SET', () => {
    expect(transactionAdapters.patchToDb({ amount: 50 })).toEqual({ amount: 50 })
    expect(transactionAdapters.patchToDb({})).toEqual({})
  })

  it('flattens a classification correction', () => {
    expect(transactionAdapters.patchToDb({ classification: { method: 'user', confidence: 1 } })).toEqual({
      classificationMethod: 'user',
      confidence: 1,
    })
  })

  it('keeps falsy-but-provided values', () => {
    expect(transactionAdapters.patchToDb({ description: 'x', date: '2026-01-01' })).toEqual({
      description: 'x',
      date: '2026-01-01',
    })
  })
})

const node = (properties: Record<string, unknown>) => ({ properties })

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

describe('wireIn adapters', () => {
  it('searchWireInToModel applies limit default of 50 when omitted', () => {
    const parsed = wireInTransactions.SearchTransactionsInput.parse({})
    expect(transactionAdapters.searchWireInToModel(parsed)).toMatchObject({ limit: 50 })
  })

  it('searchWireInToModel preserves explicit limit when provided', () => {
    const parsed = wireInTransactions.SearchTransactionsInput.parse({ limit: 10, month: 6, year: 2026 })
    expect(transactionAdapters.searchWireInToModel(parsed)).toMatchObject({ limit: 10, month: 6, year: 2026 })
  })

  it('createWireInToModel passes transaction input through unchanged', () => {
    const parsed = wireInTransactions.CreateTransactionInput.parse({
      description: 'Uber',
      amount: 32.5,
      type: 'expense',
      idempotencyKey: 'k1',
    })
    expect(transactionAdapters.createWireInToModel(parsed)).toMatchObject({
      description: 'Uber',
      amount: 32.5,
      type: 'expense',
      idempotencyKey: 'k1',
    })
  })
})

describe('dbToModel', () => {
  it('nests flat db classification back into the model', () => {
    const tx = transactionAdapters.dbToModel({
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
    const tx = transactionAdapters.dbToModel({ t: txNode, accountId: null, categoryName: null, merchant: null })
    expect(tx.accountId).toBeUndefined()
    expect(tx.toAccountId).toBeUndefined()
    expect(tx.rawInput).toBeUndefined()
  })

  it('round-trips a transfer with both account sides', () => {
    const tx = transactionAdapters.dbToModel({
      t: node({ ...txNode.properties, type: 'transfer', classificationMethod: 'none', confidence: 0 }),
      accountId: 'acc-1',
      accountName: 'Nubank',
      toAccountId: 'acc-2',
      toAccountName: 'Poupança',
    })
    expect(tx.type).toBe('transfer')
    expect(tx.toAccountName).toBe('Poupança')
  })

  it('maps tags from db record to TransactionView', () => {
    const tx = transactionAdapters.dbToModel({ t: txNode, accountId: 'acc-1', tags: ['work', 'travel'] })
    expect(tx.tags).toEqual(['work', 'travel'])
  })

  it('defaults tags to empty array when absent in db record', () => {
    const tx = transactionAdapters.dbToModel({ t: txNode, accountId: 'acc-1' })
    expect(tx.tags).toEqual([])
  })

  it('handles explicit empty tags array from db', () => {
    const tx = transactionAdapters.dbToModel({ t: txNode, accountId: 'acc-1', tags: [] })
    expect(tx.tags).toEqual([])
  })
})
