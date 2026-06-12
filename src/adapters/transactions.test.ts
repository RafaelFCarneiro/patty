import { describe, expect, it } from 'vitest'
import type { TransactionDraft } from '../models/transaction.js'
import { transactionDraftToDb, transactionPatchToDb } from './transactions.js'

const draft: TransactionDraft = {
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

describe('transactionDraftToDb', () => {
  it('flattens classification into node properties', () => {
    const { props } = transactionDraftToDb(draft)
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
    const { props, refs } = transactionDraftToDb({
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
    const { props, refs } = transactionDraftToDb({
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

describe('transactionPatchToDb', () => {
  it('emits only provided fields — absent fields never reach SET', () => {
    expect(transactionPatchToDb({ amount: 50 })).toEqual({ amount: 50 })
    expect(transactionPatchToDb({})).toEqual({})
  })

  it('flattens a classification correction', () => {
    expect(transactionPatchToDb({ classification: { method: 'user', confidence: 1 } })).toEqual({
      classificationMethod: 'user',
      confidence: 1,
    })
  })

  it('keeps falsy-but-provided values', () => {
    expect(transactionPatchToDb({ description: 'x', date: '2026-01-01' })).toEqual({
      description: 'x',
      date: '2026-01-01',
    })
  })
})
