import { describe, expect, it } from 'vitest'
import * as wireInAccounts from '../../../src/wire/in/accounts.js'
import * as accountAdapters from '../../../src/adapters/accounts.js'

// Flat SQL row as returned by a SELECT on the accounts table
const sqlRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  name: 'Nubank',
  type: 'checking',
  initial_balance: 0,
  currency: 'BRL',
  ...overrides,
})

describe('dbToModel', () => {
  it('decodes flat SQL row with currency column', () => {
    const account = accountAdapters.dbToModel(sqlRow())
    expect(account).toEqual({ id: 'acc-1', name: 'Nubank', type: 'checking', currency: 'BRL', initialBalance: 0 })
  })

  it('decodes non-zero initialBalance', () => {
    const account = accountAdapters.dbToModel(sqlRow({ initial_balance: 1500 }))
    expect(account.initialBalance).toBe(1500)
  })

  it('rejects invalid records (decode at the boundary)', () => {
    expect(() => accountAdapters.dbToModel(sqlRow({ name: '' }))).toThrow()
  })
})

describe('wireInToModel', () => {
  it('applies BRL currency and 0 initialBalance defaults when omitted', () => {
    const parsed = wireInAccounts.CreateAccount.parse({ name: 'Nubank', type: 'checking' })
    expect(accountAdapters.wireInToModel(parsed)).toEqual({ name: 'Nubank', type: 'checking', currency: 'BRL', initialBalance: 0 })
  })

  it('preserves explicit currency and initialBalance when provided', () => {
    const parsed = wireInAccounts.CreateAccount.parse({ name: 'USD Wallet', type: 'wallet', currency: 'USD', initialBalance: 500 })
    expect(accountAdapters.wireInToModel(parsed)).toEqual({ name: 'USD Wallet', type: 'wallet', currency: 'USD', initialBalance: 500 })
  })
})
