import { describe, expect, it } from 'vitest'
import * as wireInAccounts from '../wire/in/accounts.js'
import * as accountAdapters from './accounts.js'

const node = (properties: Record<string, unknown>) => ({ properties })

describe('dbToModel', () => {
  it('decodes node + currency column, defaulting initialBalance for legacy nodes', () => {
    const account = accountAdapters.dbToModel({
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
    expect(() =>
      accountAdapters.dbToModel({ a: node({ id: 'x', name: '', type: 'checking' }), currency: 'BRL' }),
    ).toThrow()
  })
})

describe('wireInToModel', () => {
  it('applies BRL currency and 0 initialBalance defaults when omitted', () => {
    const parsed = wireInAccounts.CreateAccount.parse({ name: 'Nubank', type: 'checking' })
    expect(accountAdapters.wireInToModel(parsed)).toEqual({
      name: 'Nubank',
      type: 'checking',
      currency: 'BRL',
      initialBalance: 0,
    })
  })

  it('preserves explicit currency and initialBalance when provided', () => {
    const parsed = wireInAccounts.CreateAccount.parse({
      name: 'USD Wallet',
      type: 'wallet',
      currency: 'USD',
      initialBalance: 500,
    })
    expect(accountAdapters.wireInToModel(parsed)).toEqual({
      name: 'USD Wallet',
      type: 'wallet',
      currency: 'USD',
      initialBalance: 500,
    })
  })
})
