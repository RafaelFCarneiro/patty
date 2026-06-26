import { describe, expect, it } from 'vitest'
import { areDifferentAccounts, assertCurrencyMatch, assertNonCreditType, filterByType, hasNoCards, hasNoRecurring, hasNoTransactions, isUnreferenced, withTypeLabel } from '../../../src/logic/account.js'
import type { AccountReferences } from '../../../src/models/account.js'
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

describe('assertNonCreditType', () => {
  it('passes for every manageable (non-credit) type', () => {
    for (const type of [AccountType.enum.checking, AccountType.enum.savings, AccountType.enum.wallet, AccountType.enum.investment]) {
      expect(assertNonCreditType(type)).toBe(true)
    }
  })

  it('fails for credit (card-managed)', () => {
    expect(assertNonCreditType(AccountType.enum.credit)).toBe(false)
  })

  it('passes for undefined (an omitted type is not a credit assignment)', () => {
    expect(assertNonCreditType(undefined)).toBe(true)
  })
})

describe('reference predicates', () => {
  const refs = (over: Partial<AccountReferences> = {}): AccountReferences =>
    ({ transactions: 0, recurring: 0, cards: 0, ...over })

  it('hasNoTransactions / hasNoRecurring / hasNoCards reflect their single count', () => {
    expect(hasNoTransactions(refs())).toBe(true)
    expect(hasNoTransactions(refs({ transactions: 1 }))).toBe(false)
    expect(hasNoRecurring(refs({ recurring: 2 }))).toBe(false)
    expect(hasNoCards(refs({ cards: 1 }))).toBe(false)
  })

  it('isUnreferenced is true only when every reference count is zero', () => {
    expect(isUnreferenced(refs())).toBe(true)
    expect(isUnreferenced(refs({ transactions: 1 }))).toBe(false)
    expect(isUnreferenced(refs({ recurring: 1 }))).toBe(false)
    expect(isUnreferenced(refs({ cards: 1 }))).toBe(false)
  })
})

describe('areDifferentAccounts', () => {
  it('returns true for different ids', () => {
    expect(areDifferentAccounts({ id: 'a' }, { id: 'b' })).toBe(true)
  })

  it('returns false for same id', () => {
    expect(areDifferentAccounts({ id: 'a' }, { id: 'a' })).toBe(false)
  })
})

describe('assertCurrencyMatch', () => {
  it('returns true when currencies match', () => {
    expect(assertCurrencyMatch({ currency: 'BRL' }, { currency: 'BRL' })).toBe(true)
  })

  it('returns false when currencies differ', () => {
    expect(assertCurrencyMatch({ currency: 'BRL' }, { currency: 'USD' })).toBe(false)
  })
})
