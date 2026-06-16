import { describe, expect, it } from 'vitest'
import { AccountType } from '../../../src/models/account.js'
import { CurrencyCode } from '../../../src/models/common.js'
import * as wireInAccounts from '../../../src/wire/in/accounts.js'
import * as accountAdapters from '../../../src/adapters/accounts.js'
import type { AccountRow } from '../../../src/wire/db/accounts.js'

// Row as returned by a Drizzle select on the accounts table (schema-derived shape)
const sqlRow = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  id: 'acc-1',
  name: 'Nubank',
  type: AccountType.enum.checking,
  initialBalance: 0,
  currency: CurrencyCode.enum.BRL,
  ...overrides,
})

describe('dbToModel', () => {
  it('decodes flat SQL row with currency column', () => {
    const account = accountAdapters.dbToModel(sqlRow())
    expect(account).toEqual({
      id: 'acc-1',
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 0,
    })
  })

  it('decodes non-zero initialBalance', () => {
    const account = accountAdapters.dbToModel(sqlRow({ initialBalance: 1500 }))
    expect(account.initialBalance).toBe(1500)
  })

  it('rejects invalid records (decode at the boundary)', () => {
    expect(() => accountAdapters.dbToModel(sqlRow({ name: '' }))).toThrow()
  })
})

describe('wireInToModel', () => {
  it('applies BRL currency and 0 initialBalance defaults when omitted', () => {
    const parsed = wireInAccounts.CreateAccount.parse({ name: 'Nubank', type: AccountType.enum.checking })
    expect(accountAdapters.wireInToModel(parsed)).toEqual({
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 0,
    })
  })

  it('preserves explicit currency and initialBalance when provided', () => {
    const parsed = wireInAccounts.CreateAccount.parse({
      name: 'USD Wallet',
      type: AccountType.enum.wallet,
      currency: CurrencyCode.enum.USD,
      initialBalance: 500,
    })
    expect(accountAdapters.wireInToModel(parsed)).toEqual({
      name: 'USD Wallet',
      type: AccountType.enum.wallet,
      currency: CurrencyCode.enum.USD,
      initialBalance: 500,
    })
  })
})
