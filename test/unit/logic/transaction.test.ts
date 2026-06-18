import { describe, expect, it } from 'vitest'
import { CurrencyCode } from '../../../src/models/common.js'
import { TransactionSource, TransactionView } from '../../../src/models/transaction.js'
import {
  deriveIdempotencyKey,
  guardTransferMutability,
  needsReview,
  resolveCurrency,
  resolveEffectiveType,
  summarizeBulkItems,
} from '../../../src/logic/transaction.js'

describe('deriveIdempotencyKey', () => {
  it('is stable for the same statement line', () => {
    const item = { date: '2026-06-09', description: 'PAG*UberTrip 99-SP', amount: 32.5 }
    expect(deriveIdempotencyKey(item)).toBe('2026-06-09-ubertrip-sp-32.50')
    expect(deriveIdempotencyKey(item)).toBe(deriveIdempotencyKey({ ...item }))
  })

  it('differs when amount differs', () => {
    const a = { date: '2026-06-09', description: 'IFOOD', amount: 30 }
    expect(deriveIdempotencyKey(a)).not.toBe(deriveIdempotencyKey({ ...a, amount: 31 }))
  })
})

describe('needsReview', () => {
  it('flags unclassified and low-confidence', () => {
    expect(needsReview({ method: 'none', confidence: 0 })).toBe(true)
    expect(needsReview({ method: 'history', confidence: 0.55 })).toBe(true)
    expect(needsReview({ method: 'rule', confidence: 0.8 })).toBe(false)
    expect(needsReview({ method: 'user', confidence: 1 })).toBe(false)
  })
})

describe('resolveCurrency', () => {
  const { BRL, USD } = CurrencyCode.enum
  const acc = (currency: typeof BRL | typeof USD) => ({ currency })
  const card = (currency: typeof BRL | typeof USD) => ({ currency })

  it('prefers account currency', () => {
    expect(resolveCurrency(acc(USD), card(BRL), { currency: BRL })).toBe(USD)
  })

  it('falls back to card when no account', () => {
    expect(resolveCurrency(null, card(USD), { currency: BRL })).toBe(USD)
  })

  it('falls back to explicit currency when no account or card', () => {
    expect(resolveCurrency(null, null, { currency: USD })).toBe(USD)
  })

  it('defaults to BRL when nothing is provided', () => {
    expect(resolveCurrency(null, null, {})).toBe(BRL)
  })
})

describe('guardTransferMutability', () => {
  const transfer = { type: 'transfer' as const }
  const expense = { type: 'expense' as const }

  it('rejects changing type on a transfer', () => {
    const result = guardTransferMutability(transfer, { type: 'expense' })
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().code).toBe('validation')
  })

  it('rejects setting category on a transfer', () => {
    const result = guardTransferMutability(transfer, { category: 'Alimentação' })
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().code).toBe('validation')
  })

  it('rejects setting subCategory on a transfer', () => {
    const result = guardTransferMutability(transfer, { subCategory: 'Restaurante' })
    expect(result.isErr()).toBe(true)
    expect(result._unsafeUnwrapErr().code).toBe('validation')
  })

  it('allows non-transfer updates on expense transactions', () => {
    expect(guardTransferMutability(expense, { type: 'income' }).isOk()).toBe(true)
    expect(guardTransferMutability(expense, { category: 'Alimentação' }).isOk()).toBe(true)
  })
})

describe('resolveEffectiveType', () => {
  it('uses input.type when provided', () => {
    expect(resolveEffectiveType({ type: 'expense' }, { type: 'income' })).toBe('income')
  })

  it('falls back to existing type', () => {
    expect(resolveEffectiveType({ type: 'expense' }, {})).toBe('expense')
  })

  it('returns undefined for transfers', () => {
    expect(resolveEffectiveType({ type: 'transfer' }, {})).toBeUndefined()
  })
})

describe('summarizeBulkItems', () => {
  const tx = TransactionView.parse({
    id: 'tx-1', description: 'Test', amount: 1, type: 'expense',
    status: 'effective',
    date: '2026-01-01', currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp, idempotencyKey: 'k1',
    classification: { method: 'none', confidence: 0 },
  })

  it('counts each status correctly', () => {
    const items = [
      { status: 'created' as const, transaction: tx, classification: { method: 'user' as const, confidence: 1 } },
      { status: 'needs_review' as const, transaction: tx, classification: { method: 'none' as const, confidence: 0 } },
      { status: 'needs_review' as const, transaction: tx, classification: { method: 'none' as const, confidence: 0 } },
      { status: 'duplicate' as const, transaction: tx },
      { status: 'error' as const, description: 'x', error: { code: 'validation' as const, issues: [] } },
    ]
    expect(summarizeBulkItems(items)).toEqual({ created: 1, needsReview: 2, duplicates: 1, errors: 1 })
  })

  it('returns all zeros for empty input', () => {
    expect(summarizeBulkItems([])).toEqual({ created: 0, needsReview: 0, duplicates: 0, errors: 0 })
  })
})
