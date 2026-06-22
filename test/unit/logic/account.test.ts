import { describe, expect, it } from 'vitest'
import { filterByType, withTypeLabel } from '../../../src/logic/account.js'
import { AccountType, type Account } from '../../../src/models/account.js'
import { CurrencyCode } from '../../../src/models/common.js'
import { Locale } from '../../../src/models/locale.js'

const account: Account = {
  id: 'acct-1',
  name: 'Test',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
}

describe('filterByType', () => {
  it('returns true when type is undefined (no filter)', () => {
    expect(filterByType(undefined)(account)).toBe(true)
  })

  it('returns true when type matches', () => {
    expect(filterByType(AccountType.enum.checking)(account)).toBe(true)
  })

  it('returns false when type does not match', () => {
    expect(filterByType(AccountType.enum.savings)(account)).toBe(false)
  })
})

describe('withTypeLabel', () => {
  it('adds typeLabel for the given locale (data-first)', () => {
    const labeled = withTypeLabel(account, Locale.enum.pt)
    expect(labeled.typeLabel).toBe('Conta corrente')
  })

  it('works as data-last for pipes', () => {
    const labeled = withTypeLabel(Locale.enum.es)(account)
    expect(labeled.typeLabel).toBe('Cuenta corriente')
  })

  it('preserves original type value', () => {
    const labeled = withTypeLabel(account, Locale.enum.pt)
    expect(labeled.type).toBe(AccountType.enum.checking)
  })
})
