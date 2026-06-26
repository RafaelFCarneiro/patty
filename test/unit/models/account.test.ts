import { describe, expect, it } from 'vitest'
import { accountErrors, CreateAccountSchema, UpdateAccountSchema } from '../../../src/models/account.js'
import { CurrencyCode } from '../../../src/models/common.js'

describe('accountErrors (colocated domain error payloads)', () => {
  it('creditRejected is a validation error mentioning the card flow', () => {
    expect(accountErrors.creditRejected.code).toBe('validation')
    if (accountErrors.creditRejected.code === 'validation') {
      expect(accountErrors.creditRejected.issues[0]).toContain('credit card')
    }
  })

  it('duplicateName carries the entity + name', () => {
    expect(accountErrors.duplicateName('Nubank')).toEqual({
      code: 'duplicate_name',
      entity: 'account',
      name: 'Nubank',
    })
  })

  it('typeImmutable / currencyImmutable* embed the transaction count', () => {
    expect(accountErrors.typeImmutable(3)).toMatchObject({ code: 'validation' })
    if (accountErrors.typeImmutable(3).code === 'validation') {
      expect(accountErrors.typeImmutable(3).issues[0]).toContain('3 transaction')
    }
    if (accountErrors.currencyImmutableTransactions(2).code === 'validation') {
      expect(accountErrors.currencyImmutableTransactions(2).issues[0]).toContain('2 transaction')
    }
  })
})

describe('account schemas (domain integrity vs. boundary convenience)', () => {
  it('CreateAccountSchema requires currency (integrity, not-null) — no domain default', () => {
    expect(CreateAccountSchema.safeParse({ name: 'A', type: 'checking' }).success).toBe(false)
  })

  it('CreateAccountSchema applies the integrity default for initialBalance', () => {
    const parsed = CreateAccountSchema.parse({ name: 'A', type: 'checking', currency: CurrencyCode.enum.USD })
    expect(parsed.initialBalance).toBe(0)
  })

  it('UpdateAccountSchema makes type/currency/initialBalance optional but keeps name', () => {
    expect(UpdateAccountSchema.safeParse({ name: 'A' }).success).toBe(true)
    expect(UpdateAccountSchema.safeParse({ newName: 'B' }).success).toBe(false)
  })
})
