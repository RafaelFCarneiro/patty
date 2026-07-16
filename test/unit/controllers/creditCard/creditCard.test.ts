import { describe, expect, it } from 'vitest';
import { createCreditCard, deleteCreditCard } from '../../../../src/controllers/creditCard/creditCard.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../../src/models/account.js';
import { CREDIT_CARD_ENTITY_TAG, type CreditCard, type CreditCardEntity } from '../../../../src/models/creditCard.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';
import { PersistOp } from '../../../../src/models/persistable.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-payer',
  name: 'Checking',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.BRL,
  initialBalance: 0,
  ...overrides,
});

const card = (overrides: Partial<CreditCard> = {}): CreditCard => ({
  id: 'card-existing',
  name: 'Nubank',
  currency: CurrencyCode.enum.BRL,
  closingDay: 10,
  dueDay: 20,
  accountId: 'acc-card-internal',
  ...overrides,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {
    findByName: async () => null,
    findRawById: async () =>
      ({ ...account({ id: 'acc-card-internal', name: 'Card: Nubank' }), version: 0 }) as AccountEntity,
  } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {
    findByName: async () => null,
    countCorrelated: async () => ({ transactions: 0, bills: 0 }),
    findRawById: async () => ({ ...card(), version: 7 }) as CreditCardEntity,
  } as unknown as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'minted-id',
  locale: async () => Locale.enum.en,
  resetLocale: () => {},
  ...overrides,
});

describe('createCreditCard — functional core, two-entity batch (ADR-021 phase 3a)', () => {
  it('emits [insert account, insert creditCard] — account first, the card FK depends on it', async () => {
    const deps = makeDeps();

    const result = await createCreditCard(deps, {
      name: 'Nubank',
      currency: CurrencyCode.enum.BRL,
      closingDay: 10,
      dueDay: 20,
    });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toHaveLength(2);
    expect(outcome.persist[0]).toEqual({
      op: PersistOp.enum.insert,
      entity: ACCOUNT_ENTITY_TAG,
      model: {
        id: 'minted-id',
        name: 'Card: Nubank',
        type: AccountType.enum.credit,
        currency: CurrencyCode.enum.BRL,
        initialBalance: 0,
      },
    });
    expect(outcome.persist[1]).toEqual({
      op: PersistOp.enum.insert,
      entity: CREDIT_CARD_ENTITY_TAG,
      model: {
        id: 'minted-id',
        name: 'Nubank',
        currency: CurrencyCode.enum.BRL,
        closingDay: 10,
        dueDay: 20,
        accountId: 'minted-id',
        paymentAccountId: undefined,
      },
    });
    expect(outcome.response).toEqual(outcome.persist[1].model);
  });

  it('resolves paymentAccount by name and rejects a currency mismatch', async () => {
    const deps = makeDeps({
      accounts: {
        findByName: async () => null,
        list: async () => [account({ currency: CurrencyCode.enum.USD })],
      } as unknown as Deps['accounts'],
    });

    const result = await createCreditCard(deps, {
      name: 'Nubank',
      currency: CurrencyCode.enum.BRL,
      closingDay: 10,
      dueDay: 20,
      paymentAccount: 'Checking',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a duplicate card name before touching any account resolution', async () => {
    const deps = makeDeps({
      creditCards: { findByName: async () => card() } as unknown as Deps['creditCards'],
    });

    const result = await createCreditCard(deps, {
      name: 'Nubank',
      currency: CurrencyCode.enum.BRL,
      closingDay: 10,
      dueDay: 20,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: 'duplicate_name', entity: 'credit_card', name: 'Nubank' });
  });
});

describe('deleteCreditCard — functional core, two-entity batch (ADR-021 phase 3a)', () => {
  it('a dry run (no confirm) returns a preview with an empty persist batch', async () => {
    const deps = makeDeps({
      creditCards: {
        findByName: async () => card(),
        list: async () => [card()],
        countCorrelated: async () => ({ transactions: 3, bills: 1 }),
      } as unknown as Deps['creditCards'],
    });

    const result = await deleteCreditCard(deps, { card: 'Nubank', confirm: false });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toEqual({
      deleted: false,
      dryRun: true,
      wouldDelete: { card: 'Nubank', account: 'Card: Nubank', transactions: 3, bills: 1 },
      hint: 'Destructive action: show what would be deleted to the user and call again with confirm: true.',
    });
  });

  it('confirmed emits [remove creditCard, remove account] — card first, its cascade needs it', async () => {
    const deps = makeDeps({
      creditCards: {
        findByName: async () => card(),
        list: async () => [card()],
        countCorrelated: async () => ({ transactions: 0, bills: 0 }),
        findRawById: async () => ({ ...card(), version: 7 }) as CreditCardEntity,
      } as unknown as Deps['creditCards'],
      accounts: {
        findRawById: async () => ({ ...account({ id: 'acc-card-internal' }), version: 4 }) as AccountEntity,
      } as unknown as Deps['accounts'],
    });

    const result = await deleteCreditCard(deps, { card: 'Nubank', confirm: true });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: 'card-existing', version: 7 },
      { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: 'acc-card-internal', version: 4 },
    ]);
    expect(outcome.response).toEqual({ deleted: true, card: 'Nubank' });
  });
});
