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

describe('wire CreateAccountSchema', () => {
  it('inherits .describe() from domain schema — no duplicated descriptions', () => {
    const domainType = wireInAccounts.CreateAccountSchema.shape.type.removeDefault().description
    const domainCurrency = wireInAccounts.CreateAccountSchema.shape.currency.removeDefault().description
    expect(domainType).toBeDefined()
    expect(domainCurrency).toBeDefined()
    expect(domainType).toContain('checking')
    expect(domainCurrency).toContain('ISO')
  })
})

describe('wire UpdateAccountSchema (HTTP PATCH pattern)', () => {
  it('rejects body without name (domain requires it)', () => {
    expect(wireInAccounts.UpdateAccountSchema.safeParse({ newName: 'B' }).success).toBe(false)
  })

  it('succeeds when name is merged from URL params before parsing', () => {
    const body = { newName: 'Renamed' }
    const merged = { ...body, name: 'Original' }
    const result = wireInAccounts.UpdateAccountSchema.safeParse(merged)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject({ name: 'Original', newName: 'Renamed' })
    }
  })
})

describe('createWireInToModel', () => {
  it('applies USD currency and 0 initialBalance defaults when omitted', () => {
    const parsed = wireInAccounts.CreateAccountSchema.parse({ name: 'Nubank', type: AccountType.enum.checking })
    expect(accountAdapters.createWireInToModel(parsed)).toEqual({
      name: 'Nubank',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.USD,
      initialBalance: 0,
    })
  })

  it('preserves explicit currency and initialBalance when provided', () => {
    const parsed = wireInAccounts.CreateAccountSchema.parse({
      name: 'USD Wallet',
      type: AccountType.enum.wallet,
      currency: CurrencyCode.enum.USD,
      initialBalance: 500,
    })
    expect(accountAdapters.createWireInToModel(parsed)).toEqual({
      name: 'USD Wallet',
      type: AccountType.enum.wallet,
      currency: CurrencyCode.enum.USD,
      initialBalance: 500,
    })
  })
})

describe('updateWireInToModel', () => {
  it('passes through a full update payload unchanged', () => {
    const parsed = wireInAccounts.UpdateAccountSchema.parse({
      name: 'Nubank',
      newName: 'Nubank Ultravioleta',
      type: AccountType.enum.checking,
      currency: CurrencyCode.enum.BRL,
      initialBalance: 100,
    })
    expect(accountAdapters.updateWireInToModel(parsed)).toEqual(parsed)
  })

  it('passes through a minimal update (name only) unchanged', () => {
    const parsed = wireInAccounts.UpdateAccountSchema.parse({ name: 'Nubank' })
    expect(accountAdapters.updateWireInToModel(parsed)).toEqual({ name: 'Nubank' })
  })
})
