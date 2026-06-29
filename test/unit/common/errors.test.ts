import { describe, expect, it } from 'vitest'
import { formatAppError, httpStatus, type AppError } from '../../../src/common/errors.js'

const REPRESENTATIVE_ERRORS: Array<{ error: AppError; expectedStatus: number; expectedSubstring: string }> = [
  { error: { code: 'unknown_account', query: 'Nubank', candidates: ['Itaú'] }, expectedStatus: 404,
    expectedSubstring: 'unknown_account' },
  { error: { code: 'ambiguous_account', query: 'Nu', candidates: ['Nubank', 'NuInvest'] }, expectedStatus: 409,
    expectedSubstring: 'ambiguous_account' },
  { error: { code: 'unknown_category', query: 'Foo', candidates: [] }, expectedStatus: 404,
    expectedSubstring: 'unknown_category' },
  { error: { code: 'ambiguous_category', query: 'Fo', candidates: ['Food', 'Footwear'] }, expectedStatus: 409,
    expectedSubstring: 'ambiguous_category' },
  { error: { code: 'unknown_sub_category', query: 'Bar', candidates: [] }, expectedStatus: 404,
    expectedSubstring: 'unknown_sub_category' },
  { error: { code: 'ambiguous_sub_category', query: 'Ba', candidates: ['Bar', 'Bakery'] }, expectedStatus: 409,
    expectedSubstring: 'ambiguous_sub_category' },
  { error: { code: 'unknown_card', query: 'Visa', candidates: [] }, expectedStatus: 404,
    expectedSubstring: 'unknown_card' },
  { error: { code: 'ambiguous_card', query: 'Nu', candidates: ['Nubank', 'NuGold'] }, expectedStatus: 409,
    expectedSubstring: 'ambiguous_card' },
  { error: { code: 'duplicate_name', entity: 'account', name: 'Nubank' }, expectedStatus: 409,
    expectedSubstring: 'duplicate_name' },
  { error: { code: 'duplicate_name', entity: 'category', name: 'Food' }, expectedStatus: 409,
    expectedSubstring: 'duplicate_name' },
  { error: { code: 'duplicate_name', entity: 'sub_category', name: 'Fast Food' }, expectedStatus: 409,
    expectedSubstring: 'duplicate_name' },
  { error: { code: 'duplicate_name', entity: 'credit_card', name: 'Visa' }, expectedStatus: 409,
    expectedSubstring: 'duplicate_name' },
  { error: { code: 'duplicate_name', entity: 'tag', name: 'travel' }, expectedStatus: 409,
    expectedSubstring: 'duplicate_name' },
  { error: { code: 'unknown_transaction', id: 'tx-1' }, expectedStatus: 404, expectedSubstring: 'unknown_transaction' },
  { error: { code: 'unknown_bill', card: 'Nubank', month: 6, year: 2026 }, expectedStatus: 404,
    expectedSubstring: 'unknown_bill' },
  { error: { code: 'category_kind_mismatch', transactionType: 'income', categoryName: 'Food', categoryKind: 'expense',
    hint: 'Food is expense-only' }, expectedStatus: 422, expectedSubstring: 'category_kind_mismatch' },
  { error: { code: 'in_use', entity: 'category', name: 'Food', references: { transactions: 3, recurring: 1,
    subCategories: 2 } }, expectedStatus: 409, expectedSubstring: 'in_use' },
  { error: { code: 'in_use', entity: 'sub_category', name: 'Fast Food', references: { transactions: 1, recurring: 0,
    subCategories: 0 } }, expectedStatus: 409, expectedSubstring: 'in_use' },
  { error: { code: 'in_use', entity: 'account', name: 'Nubank', references: { transactions: 5, recurring: 2,
    cards: 1 } }, expectedStatus: 409, expectedSubstring: 'in_use' },
  { error: { code: 'validation', issues: ['bad input'] }, expectedStatus: 422, expectedSubstring: 'validation' },
]

describe('formatAppError / httpStatus exhaustiveness', () => {
  it.each(REPRESENTATIVE_ERRORS)(
    '$error.code ($error.entity) → status $expectedStatus',
    ({ error, expectedStatus, expectedSubstring }) => {
      expect(httpStatus(error)).toBe(expectedStatus)
      expect(formatAppError(error)).toContain(expectedSubstring)
    },
  )

  it('formatAppError produces the same output shape for in_use account (cards field)', () => {
    const err: AppError = { code: 'in_use', entity: 'account', name: 'X', references: { transactions: 1, recurring: 2,
      cards: 3 } }
    expect(formatAppError(err)).toBe('in_use: account "X" (transactions: 1, recurring: 2, cards: 3)')
  })

  it('formatAppError produces the same output shape for in_use category (subCategories field)', () => {
    const err: AppError = { code: 'in_use', entity: 'category', name: 'Y', references: { transactions: 4, recurring: 0,
      subCategories: 1 } }
    expect(formatAppError(err)).toBe('in_use: category "Y" (transactions: 4, recurring: 0, subCategories: 1)')
  })

  it('formatAppError for unknown_bill matches the original format', () => {
    const err: AppError = { code: 'unknown_bill', card: 'Nubank', month: 6, year: 2026 }
    expect(formatAppError(err)).toBe('unknown_bill: Nubank 2026-06')
  })
})
