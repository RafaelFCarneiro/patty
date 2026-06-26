import { describe, expect, it } from 'vitest'
import { validation } from '../../../src/models/error.js'
import { categoryErrors } from '../../../src/models/category.js'
import { cardErrors } from '../../../src/models/creditCard.js'
import { transactionErrors } from '../../../src/models/transaction.js'
import { billErrors } from '../../../src/models/bill.js'
import { tagErrors } from '../../../src/models/tag.js'

describe('shared error primitives', () => {
  it('validation() builds a ValidationError with code and issues', () => {
    const err = validation(['field is required', 'must be positive'])
    expect(err).toEqual({ code: 'validation', issues: ['field is required', 'must be positive'] })
  })
})

describe('per-model error builders', () => {
  it('categoryErrors.duplicateName carries entity and name', () => {
    expect(categoryErrors.duplicateName('category', 'Food')).toEqual({
      code: 'duplicate_name', entity: 'category', name: 'Food',
    })
    expect(categoryErrors.duplicateName('sub_category', 'Fast Food')).toEqual({
      code: 'duplicate_name', entity: 'sub_category', name: 'Fast Food',
    })
  })

  it('categoryErrors.inUse carries entity, name, and references', () => {
    const refs = { transactions: 5, recurring: 1, subCategories: 2 }
    expect(categoryErrors.inUse('category', 'Food', refs)).toEqual({
      code: 'in_use', entity: 'category', name: 'Food', references: refs,
    })
  })

  it('categoryErrors.kindMismatch builds the hint string', () => {
    const err = categoryErrors.kindMismatch('income', 'Food', 'expense')
    expect(err.code).toBe('category_kind_mismatch')
    expect(err.hint).toContain('expense-only')
    expect(err.hint).toContain('Food')
  })

  it('cardErrors.duplicateName uses credit_card entity', () => {
    expect(cardErrors.duplicateName('Nubank')).toEqual({
      code: 'duplicate_name', entity: 'credit_card', name: 'Nubank',
    })
  })

  it('transactionErrors.notFound carries the id', () => {
    expect(transactionErrors.notFound('tx-123')).toEqual({
      code: 'unknown_transaction', id: 'tx-123',
    })
  })

  it('billErrors.notFound carries card, month, year', () => {
    expect(billErrors.notFound('Nubank', 6, 2026)).toEqual({
      code: 'unknown_bill', card: 'Nubank', month: 6, year: 2026,
    })
  })

  it('tagErrors.duplicateName uses tag entity', () => {
    expect(tagErrors.duplicateName('travel')).toEqual({
      code: 'duplicate_name', entity: 'tag', name: 'travel',
    })
  })
})
