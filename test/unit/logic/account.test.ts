import { describe, expect, it } from 'vitest';
import {
  areDifferentAccounts,
  assertCurrencyMatch,
  assertNonCreditType,
  changesPinnedField,
  filterByType,
  guardPinnedFields,
  guardTransferMutability,
  hasNoCards,
  hasNoRecurring,
  hasNoTransactions,
  isAccountOwnedType,
  isRename,
  isUnreferenced,
  mergeAccountPatch,
  planTransfer,
  withTypeLabel,
} from '../../../src/logic/account.js';
import { accountErrors, type AccountEntity, type AccountReferences } from '../../../src/models/account.js';
import { TransactionSource } from '../../../src/models/transaction.js';
import { deriveIdempotencyKey } from '../../../src/logic/transaction.js';
import { AccountType, type Account } from '../../../src/models/account.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';

const account: Account = {
  id: 'acct-1',
  name: 'Test',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
};

describe('filterByType', () => {
  it('returns true when type is undefined (no filter)', () => {
    expect(filterByType(undefined)(account)).toBe(true);
  });

  it('returns true when type matches', () => {
    expect(filterByType(AccountType.enum.checking)(account)).toBe(true);
  });

  it('returns false when type does not match', () => {
    expect(filterByType(AccountType.enum.savings)(account)).toBe(false);
  });
});

describe('withTypeLabel', () => {
  it('adds typeLabel for the given locale (data-first)', () => {
    const labeled = withTypeLabel(account, Locale.enum.pt);
    expect(labeled.typeLabel).toBe('Conta corrente');
  });

  it('works as data-last for pipes', () => {
    const labeled = withTypeLabel(Locale.enum.es)(account);
    expect(labeled.typeLabel).toBe('Cuenta corriente');
  });

  it('preserves original type value', () => {
    const labeled = withTypeLabel(account, Locale.enum.pt);
    expect(labeled.type).toBe(AccountType.enum.checking);
  });
});

describe('assertNonCreditType', () => {
  it('passes for every manageable (non-credit) type', () => {
    const manageable = [
      AccountType.enum.checking,
      AccountType.enum.savings,
      AccountType.enum.wallet,
      AccountType.enum.investment,
    ];
    for (const type of manageable) {
      expect(assertNonCreditType(type)).toBe(true);
    }
  });

  it('fails for credit (card-managed)', () => {
    expect(assertNonCreditType(AccountType.enum.credit)).toBe(false);
  });

  it('passes for undefined (an omitted type is not a credit assignment)', () => {
    expect(assertNonCreditType(undefined)).toBe(true);
  });
});

describe('isAccountOwnedType (ADR-020 — positive scope, not a negation of credit)', () => {
  it('is true for every type the account aggregate owns', () => {
    const owned = [
      AccountType.enum.checking,
      AccountType.enum.savings,
      AccountType.enum.wallet,
      AccountType.enum.investment,
    ];
    for (const type of owned) {
      expect(isAccountOwnedType(type)).toBe(true);
    }
  });

  it('is false for credit (owned by the credit-card aggregate instead)', () => {
    expect(isAccountOwnedType(AccountType.enum.credit)).toBe(false);
  });
});

describe('reference predicates', () => {
  const refs = (over: Partial<AccountReferences> = {}): AccountReferences => ({
    transactions: 0,
    recurring: 0,
    cards: 0,
    ...over,
  });

  it('hasNoTransactions / hasNoRecurring / hasNoCards reflect their single count', () => {
    expect(hasNoTransactions(refs())).toBe(true);
    expect(hasNoTransactions(refs({ transactions: 1 }))).toBe(false);
    expect(hasNoRecurring(refs({ recurring: 2 }))).toBe(false);
    expect(hasNoCards(refs({ cards: 1 }))).toBe(false);
  });

  it('isUnreferenced is true only when every reference count is zero', () => {
    expect(isUnreferenced(refs())).toBe(true);
    expect(isUnreferenced(refs({ transactions: 1 }))).toBe(false);
    expect(isUnreferenced(refs({ recurring: 1 }))).toBe(false);
    expect(isUnreferenced(refs({ cards: 1 }))).toBe(false);
  });
});

describe('areDifferentAccounts', () => {
  it('returns true for different ids', () => {
    expect(areDifferentAccounts({ id: 'a' }, { id: 'b' })).toBe(true);
  });

  it('returns false for same id', () => {
    expect(areDifferentAccounts({ id: 'a' }, { id: 'a' })).toBe(false);
  });
});

describe('assertCurrencyMatch', () => {
  it('returns true when currencies match', () => {
    expect(assertCurrencyMatch({ currency: 'BRL' }, { currency: 'BRL' })).toBe(true);
  });

  it('returns false when currencies differ', () => {
    expect(assertCurrencyMatch({ currency: 'BRL' }, { currency: 'USD' })).toBe(false);
  });
});

describe('guardTransferMutability (ADR-020 §4 — account context only)', () => {
  const transfer = { type: 'transfer' as const };
  const expense = { type: 'expense' as const };

  it('rejects changing type on a transfer', () => {
    const result = guardTransferMutability(transfer, { type: 'expense' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects setting category on a transfer', () => {
    const result = guardTransferMutability(transfer, { category: 'Alimentação' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects setting subCategory on a transfer', () => {
    const result = guardTransferMutability(transfer, { subCategory: 'Restaurante' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('allows non-transfer updates on expense transactions', () => {
    expect(guardTransferMutability(expense, { type: 'income' }).isOk()).toBe(true);
    expect(guardTransferMutability(expense, { category: 'Alimentação' }).isOk()).toBe(true);
  });
});

describe('isRename', () => {
  it('is a rename when the name differs beyond case', () => {
    expect(isRename('Itau', 'Bradesco')).toBe(true);
  });

  it('a case-only change, the same name, or no new name is not a rename', () => {
    expect(isRename('Itau', 'itau')).toBe(false);
    expect(isRename('Itau', 'Itau')).toBe(false);
    expect(isRename('Itau', undefined)).toBe(false);
  });
});

describe('pinned fields — type and currency once the account has activity', () => {
  const none: AccountReferences = { transactions: 0, recurring: 0, cards: 0 };

  it('only a type or currency in the patch touches a pinned field', () => {
    expect(changesPinnedField({})).toBe(false);
    expect(changesPinnedField({ type: AccountType.enum.savings })).toBe(true);
    expect(changesPinnedField({ currency: CurrencyCode.enum.USD })).toBe(true);
  });

  it('allows the change on an account with no references', () => {
    expect(guardPinnedFields(none, { type: AccountType.enum.savings, currency: CurrencyCode.enum.USD }).isOk()).toBe(
      true,
    );
  });

  it('allows an empty patch whatever the references', () => {
    expect(guardPinnedFields({ transactions: 3, recurring: 1, cards: 1 }, {}).isOk()).toBe(true);
  });

  it('refuses a type change once there are transactions', () => {
    const result = guardPinnedFields({ ...none, transactions: 2 }, { type: AccountType.enum.savings });
    expect(result._unsafeUnwrapErr()).toEqual(accountErrors.typeImmutable(2));
  });

  it('refuses a currency change for transactions, then recurring rules, then cards — first violation wins', () => {
    const currency = { currency: CurrencyCode.enum.USD };
    expect(guardPinnedFields({ transactions: 4, recurring: 1, cards: 1 }, currency)._unsafeUnwrapErr()).toEqual(
      accountErrors.currencyImmutableTransactions(4),
    );
    expect(guardPinnedFields({ ...none, recurring: 1, cards: 1 }, currency)._unsafeUnwrapErr()).toEqual(
      accountErrors.currencyImmutableRecurring,
    );
    expect(guardPinnedFields({ ...none, cards: 1 }, currency)._unsafeUnwrapErr()).toEqual(
      accountErrors.currencyImmutableCards,
    );
  });

  it('reports the type violation before a currency one when both change', () => {
    const result = guardPinnedFields(
      { ...none, transactions: 1 },
      { type: AccountType.enum.savings, currency: CurrencyCode.enum.USD },
    );
    expect(result._unsafeUnwrapErr()).toEqual(accountErrors.typeImmutable(1));
  });

  it('a currency-only patch is not blocked by a type rule', () => {
    expect(guardPinnedFields({ ...none, recurring: 2 }, { type: undefined }).isOk()).toBe(true);
  });
});

describe('mergeAccountPatch', () => {
  const raw: AccountEntity = { ...account, initialBalance: 50, version: 3 };

  it('keeps the account when nothing is patched', () => {
    expect(mergeAccountPatch(raw, { name: 'Test' })).toEqual(raw);
  });

  it('renames through newName and takes each provided field, keeping id and version', () => {
    const merged = mergeAccountPatch(raw, {
      name: 'Test',
      newName: 'Renamed',
      initialBalance: 0,
      type: AccountType.enum.savings,
      currency: CurrencyCode.enum.USD,
    });
    expect(merged).toEqual({
      ...raw,
      name: 'Renamed',
      initialBalance: 0,
      type: AccountType.enum.savings,
      currency: CurrencyCode.enum.USD,
    });
  });

  it('a zero initial balance is a value, not an omission', () => {
    expect(mergeAccountPatch(raw, { name: 'Test', initialBalance: 0 }).initialBalance).toBe(0);
  });
});

describe('planTransfer', () => {
  const from = { id: 'acc-1', name: 'Checking', currency: CurrencyCode.enum.BRL };
  const to = { id: 'acc-2', name: 'Savings' };
  const facts = (input: Partial<Parameters<typeof planTransfer>[0]['input']> = {}) => ({
    id: 'tx-new',
    today: '2026-06-10',
    input: { from: 'Checking', to: 'Savings', amount: 100, ...input },
    from,
    to,
    source: TransactionSource.enum.mcp,
    decimals: 2,
  });

  it('plans an unclassified transfer between the two accounts in the source currency', () => {
    const { entity } = planTransfer(facts());
    expect(entity).toEqual({
      id: 'tx-new',
      description: 'Transferência: Checking → Savings',
      amount: 100,
      type: 'transfer',
      status: 'effective',
      date: '2026-06-10',
      currency: 'BRL',
      source: 'mcp',
      classification: { method: 'none', confidence: 0 },
      refs: { accountId: 'acc-1', toAccountId: 'acc-2' },
    });
  });

  it('an explicit description, date and status win; a future date defaults to pending', () => {
    expect(planTransfer(facts({ description: 'Rent', date: '2026-06-01' })).entity).toMatchObject({
      description: 'Rent',
      date: '2026-06-01',
      status: 'effective',
    });
    expect(planTransfer(facts({ date: '2026-07-01' })).entity.status).toBe('pending');
    expect(planTransfer(facts({ date: '2026-07-01', status: 'effective' })).entity.status).toBe('effective');
  });

  it('keys on both accounts and the caller description, never on the display-name placeholder', () => {
    const base = {
      fundingSourceId: 'acc-1',
      counterpartyId: 'acc-2',
      type: 'transfer' as const,
      currency: CurrencyCode.enum.BRL,
      date: '2026-06-10',
      amount: 100,
    };
    expect(planTransfer(facts()).idempotencyKey).toBe(deriveIdempotencyKey({ ...base, description: '' }, 2));
    const renamed = { ...facts(), from: { ...from, name: 'Renamed' } };
    expect(planTransfer(renamed).idempotencyKey).toBe(planTransfer(facts()).idempotencyKey);
    expect(planTransfer(facts({ description: 'Rent' })).idempotencyKey).toBe(
      deriveIdempotencyKey({ ...base, description: 'Rent' }, 2),
    );
  });

  it('a different destination or discriminator derives a different key', () => {
    const key = planTransfer(facts()).idempotencyKey;
    expect(planTransfer({ ...facts(), to: { id: 'acc-3', name: 'Other' } }).idempotencyKey).not.toBe(key);
    expect(planTransfer(facts({ discriminator: 'second' })).idempotencyKey).not.toBe(key);
  });
});
