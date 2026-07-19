import { describe, expect, it } from 'vitest';
import { createCreditCard, deleteCreditCard } from '../../../../src/controllers/creditCard/creditCard.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { ACCOUNT_ENTITY_TAG, AccountType, type Account, type AccountEntity } from '../../../../src/models/account.js';
import { BILL_ENTITY_TAG, BillStatus, type RawBill } from '../../../../src/models/bill.js';
import {
  CREDIT_CARD_ENTITY_TAG,
  DELETE_CREDIT_CARD_CONFIRM_HINT,
  type CreditCard,
  type CreditCardEntity,
} from '../../../../src/models/creditCard.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';
import { PersistOp } from '../../../../src/models/persistable.js';
import {
  ClassificationMethod,
  TRANSACTION_ENTITY_TAG,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  type RawTransactionView,
} from '../../../../src/models/transaction.js';

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

const rawBill = (overrides: Partial<RawBill> = {}): RawBill => ({
  id: 'bill-1',
  creditCardId: 'card-existing',
  month: 6,
  year: 2026,
  closeDate: '2026-06-28',
  dueDate: '2026-07-05',
  status: BillStatus.enum.closed,
  version: 2,
  ...overrides,
});

const rawTransaction = (overrides: Partial<RawTransactionView> = {}): RawTransactionView => ({
  id: 'tx-1',
  description: 'Purchase',
  amount: 50,
  type: TransactionType.enum.expense,
  status: TransactionStatus.enum.effective,
  date: '2026-06-01',
  currency: CurrencyCode.enum.BRL,
  source: TransactionSource.enum.mcp,
  idempotencyKey: 'idem-1',
  classification: { method: ClassificationMethod.enum.none, confidence: 0 },
  tags: [],
  version: 0,
  ...overrides,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: {
    findByName: async () => null,
    findRawById: async () =>
      ({ ...account({ id: 'acc-card-internal', name: 'Card: Nubank' }), version: 0 }) as AccountEntity,
  } as unknown as Deps['accounts'],
  bills: { findAllByCard: async () => [] } as unknown as Deps['bills'],
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
  transactions: { findAllCorrelatedToCard: async () => [] } as unknown as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'minted-id',
  locale: async () => Locale.enum.en,
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
    expect(outcome.response).toEqual({
      id: 'minted-id',
      name: 'Nubank',
      currency: CurrencyCode.enum.BRL,
      closingDay: 10,
      dueDay: 20,
      accountId: 'minted-id',
      paymentAccountId: undefined,
    });
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
      hint: DELETE_CREDIT_CARD_CONFIRM_HINT,
    });
  });

  const confirmedDeps = (overrides: Partial<Deps> = {}): Deps =>
    makeDeps({
      creditCards: {
        findByName: async () => card(),
        list: async () => [card()],
        countCorrelated: async () => ({ transactions: 0, bills: 0 }),
        findRawById: async () => ({ ...card(), version: 7 }) as CreditCardEntity,
      } as unknown as Deps['creditCards'],
      accounts: {
        findRawById: async () => ({ ...account({ id: 'acc-card-internal' }), version: 4 }) as AccountEntity,
      } as unknown as Deps['accounts'],
      ...overrides,
    });

  it('with no correlated rows, emits just [remove creditCard, remove account] — card first', async () => {
    const deps = confirmedDeps();

    const result = await deleteCreditCard(deps, { card: 'Nubank', confirm: true });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: 'card-existing', version: 7 },
      { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: 'acc-card-internal', version: 4 },
    ]);
    expect(outcome.response).toEqual({ deleted: true, card: 'Nubank' });
  });

  it('the domain decides the cascade: transactions and an unpaid bill removed before the card', async () => {
    const deps = confirmedDeps({
      bills: { findAllByCard: async () => [rawBill({ paymentTransactionId: undefined })] } as unknown as Deps['bills'],
      transactions: {
        findAllCorrelatedToCard: async () => [rawTransaction({ id: 'tx-1' }), rawTransaction({ id: 'tx-2' })],
      } as unknown as Deps['transactions'],
    });

    const result = await deleteCreditCard(deps, { card: 'Nubank', confirm: true });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([
      { op: PersistOp.enum.delete, entity: TRANSACTION_ENTITY_TAG, id: 'tx-1', version: 0 },
      { op: PersistOp.enum.delete, entity: TRANSACTION_ENTITY_TAG, id: 'tx-2', version: 0 },
      { op: PersistOp.enum.delete, entity: BILL_ENTITY_TAG, id: 'bill-1', version: 2 },
      { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: 'card-existing', version: 7 },
      { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: 'acc-card-internal', version: 4 },
    ]);
  });

  it('a paid bill: clears paymentTransactionId, removes the transfer, removes the bill at version+1', async () => {
    const deps = confirmedDeps({
      bills: {
        findAllByCard: async () => [rawBill({ paymentTransactionId: 'tx-payment', status: BillStatus.enum.paid })],
      } as unknown as Deps['bills'],
      transactions: {
        findAllCorrelatedToCard: async () => [
          rawTransaction({ id: 'tx-payment', type: TransactionType.enum.transfer }),
        ],
      } as unknown as Deps['transactions'],
    });

    const result = await deleteCreditCard(deps, { card: 'Nubank', confirm: true });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    // Bill-clear (breaking the bill<->transfer circular FK) precedes the transfer's own removal,
    // which precedes the bill's own removal — at version+1, the version the shell will have
    // already bumped the clearing update to by the time this delete applies in the same batch.
    expect(outcome.persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: BILL_ENTITY_TAG,
        model: {
          id: 'bill-1',
          creditCardId: 'card-existing',
          month: 6,
          year: 2026,
          closeDate: '2026-06-28',
          dueDate: '2026-07-05',
          status: BillStatus.enum.paid,
          paymentTransactionId: null,
          version: 2,
        },
      },
      { op: PersistOp.enum.delete, entity: TRANSACTION_ENTITY_TAG, id: 'tx-payment', version: 0 },
      { op: PersistOp.enum.delete, entity: BILL_ENTITY_TAG, id: 'bill-1', version: 3 },
      { op: PersistOp.enum.delete, entity: CREDIT_CARD_ENTITY_TAG, id: 'card-existing', version: 7 },
      { op: PersistOp.enum.delete, entity: ACCOUNT_ENTITY_TAG, id: 'acc-card-internal', version: 4 },
    ]);
  });
});
