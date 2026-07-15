import { describe, expect, it, vi } from 'vitest';
import {
  addCardPurchase,
  deleteCardTransaction,
  updateCardTransaction,
} from '../../../../src/controllers/creditCard/transaction.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import type { CreditCard } from '../../../../src/models/creditCard.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';
import { BillStatus, type RawBill } from '../../../../src/models/bill.js';
import { PersistOp, type PersistOutcome } from '../../../../src/models/persistable.js';
import {
  TransactionSource,
  type RawTransactionView,
  type TransactionView,
} from '../../../../src/models/transaction.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-checking',
  name: 'Checking',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.USD,
  initialBalance: 0,
  ...overrides,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { findById: async () => null } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  creditCards: {} as Deps['creditCards'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: { matchCandidates: async () => [] } as unknown as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-01'),
  newId: () => 'test-id',
  locale: async () => Locale.enum.en,
  resetLocale: vi.fn(),
  ...overrides,
});

const card = (overrides: Partial<CreditCard> = {}): CreditCard => ({
  id: 'card-1',
  name: 'Test Card',
  currency: CurrencyCode.enum.USD,
  closingDay: 28,
  dueDay: 5,
  accountId: 'acc-card-internal',
  ...overrides,
});

const rawBill = (overrides: Partial<RawBill> = {}): RawBill => ({
  id: 'bill-1',
  creditCardId: 'card-1',
  month: 6,
  year: 2026,
  closeDate: '2026-06-28',
  dueDate: '2026-07-05',
  status: BillStatus.enum.open,
  version: 2,
  ...overrides,
});

/** Deterministic, distinguishable ids across a single test — the default `makeDeps` `newId`
 *  returns a constant, which would make a fresh bill id and a fresh transaction id collide in the
 *  same assertion. */
const sequentialNewId = (): (() => string) => {
  let n = 0;
  return () => `id-${n++}`;
};

describe('addCardPurchase — the write is returned as data, not performed (ADR-021 phase 2b)', () => {
  it('on a brand-new cycle, emits a bill insert before a transaction insert referencing it', async () => {
    const deps = makeDeps({
      creditCards: { list: async () => [card()] } as unknown as Deps['creditCards'],
      bills: { findByCycle: async () => null } as unknown as Deps['bills'],
      newId: sequentialNewId(),
    });

    const result = await addCardPurchase(
      deps,
      {
        description: 'New purchase',
        amount: 30,
        type: 'expense',
        date: '2026-06-15',
        card: 'Test Card',
        idempotencyKey: 'k1',
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.insert, entity: 'bill' });
    const billModel = (persist[0] as { model: { id: string; creditCardId: string; status: string } }).model;
    expect(billModel.creditCardId).toBe('card-1');
    expect(billModel.status).toBe(BillStatus.enum.open);

    expect(persist[1]).toMatchObject({ op: PersistOp.enum.insert, entity: 'transaction' });
    const txModel = (persist[1] as { model: { refs: { billId?: string } } }).model;
    expect(txModel.refs.billId).toBe(billModel.id);
  });

  it('on an existing open cycle, emits a version-guarded bill touch (not an insert)', async () => {
    const existingBill = rawBill();
    const deps = makeDeps({
      creditCards: { list: async () => [card()] } as unknown as Deps['creditCards'],
      bills: { findByCycle: async () => existingBill } as unknown as Deps['bills'],
      newId: sequentialNewId(),
    });

    const result = await addCardPurchase(
      deps,
      {
        description: 'Repeat cycle purchase',
        amount: 12,
        type: 'expense',
        date: '2026-06-15',
        card: 'Test Card',
        idempotencyKey: 'k2',
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: existingBill.id, version: existingBill.version },
    });
    const txModel = (persist[1] as { model: { refs: { billId?: string } } }).model;
    expect(txModel.refs.billId).toBe(existingBill.id);
  });

  it('rejects landing on an already-paid bill before building any write', async () => {
    const deps = makeDeps({
      creditCards: { list: async () => [card()] } as unknown as Deps['creditCards'],
      bills: { findByCycle: async () => rawBill({ status: BillStatus.enum.paid }) } as unknown as Deps['bills'],
    });

    const result = await addCardPurchase(
      deps,
      {
        description: 'Blocked purchase',
        amount: 12,
        type: 'expense',
        date: '2026-06-15',
        card: 'Test Card',
        idempotencyKey: 'k3',
      },
      TransactionSource.enum.mcp,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('revert_bill_payment');
  });

  it("response() resolves the LAST persist outcome (the transaction's, not the bill's)", async () => {
    const deps = makeDeps({
      creditCards: { list: async () => [card()] } as unknown as Deps['creditCards'],
      bills: { findByCycle: async () => null } as unknown as Deps['bills'],
      newId: sequentialNewId(),
    });

    const result = await addCardPurchase(
      deps,
      {
        description: 'Response check',
        amount: 30,
        type: 'expense',
        date: '2026-06-15',
        card: 'Test Card',
        idempotencyKey: 'k4',
      },
      TransactionSource.enum.mcp,
    );
    const outcome = result._unsafeUnwrap();
    expect(typeof outcome.response).toBe('function');

    const billOutcome: PersistOutcome = { applied: true };
    const txOutcome: PersistOutcome = {
      applied: true,
      read: {
        id: 'tx-new',
        description: 'Response check',
        amount: 30,
        type: 'expense',
        status: 'effective',
        date: '2026-06-15',
        currency: 'USD',
        source: 'mcp',
        idempotencyKey: 'k4',
        classification: { method: 'none', confidence: 0 },
        tags: [],
        version: 0,
      } as RawTransactionView,
    };
    const response = (
      outcome.response as (outcomes: PersistOutcome[]) => { created: boolean; transaction: { id: string } }
    )([billOutcome, txOutcome]);
    expect(response.created).toBe(true);
    expect(response.transaction.id).toBe('tx-new');
  });
});

const baseTx: RawTransactionView = {
  id: 'tx-1',
  description: 'Card purchase',
  amount: 40,
  type: 'expense',
  status: 'effective',
  date: '2026-06-01',
  currency: 'USD',
  source: 'mcp',
  idempotencyKey: 'existing-key',
  classification: { method: 'none', confidence: 0 },
  tags: [],
  version: 3,
};

const checkingAccountsById = { findById: async () => account({ type: AccountType.enum.checking }) };

describe('updateCardTransaction / deleteCardTransaction — ownership by account type (ADR-020)', () => {
  it('updateCardTransaction rejects a tx with no credit leg, redirecting to update_account_transaction', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-checking' }),
      } as unknown as Deps['transactions'],
      accounts: checkingAccountsById as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', description: 'Changed' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('update_account_transaction');
  });

  it('deleteCardTransaction rejects a tx with no credit leg, redirecting to delete_account_transaction', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-checking' }),
      } as unknown as Deps['transactions'],
      accounts: checkingAccountsById as unknown as Deps['accounts'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('delete_account_transaction');
  });
});

describe('updateCardTransaction — account field (ADR-019 compose-up watchpoint)', () => {
  // UpdateCardTransactionSchema still accepts `account` (extended onto the minimal core, not
  // omitted) precisely so this dedicated, friendly error fires — a `.strict()` rejection of an
  // unrecognized key would replace it with a generic schema-validation error instead.
  it('rejects a present account with the dedicated accountChangeRejectedForCard message', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...baseTx, accountId: 'acc-card-internal', cardId: 'card-1' }),
      } as unknown as Deps['transactions'],
      accounts: {
        findById: async () => account({ id: 'acc-card-internal', type: AccountType.enum.credit }),
      } as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', account: 'Nubank' });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('cannot change the account of a card transaction');
  });
});

describe('updateCardTransaction / deleteCardTransaction — bill-payment transfer immutability (ADR-020 §3)', () => {
  // billId set, no cardId: definitionally the transfer pay_bill created — nothing else in the domain
  // has billId without cardId. Its toAccountId is the card's own internal (credit) account — the leg
  // that makes it card-owned under ADR-020's account-type rule.
  const paymentTransfer: TransactionView = {
    ...baseTx,
    cardId: undefined,
    billId: 'bill-1',
    accountId: 'acc-payer',
    toAccountId: 'acc-card-internal',
  };
  const accountsById: Record<string, Account> = {
    'acc-payer': account({ id: 'acc-payer', type: AccountType.enum.checking }),
    'acc-card-internal': account({ id: 'acc-card-internal', type: AccountType.enum.credit }),
  };
  const findById = async (id: string) => accountsById[id] ?? null;

  it('updateCardTransaction rejects any edit, not just reassignment — never via transfer-immutability', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => paymentTransfer } as unknown as Deps['transactions'],
      accounts: { findById } as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', amount: 999 });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    // Rejected via the bill-process guard (paidBillImmutable), not transfer-type-immutable —
    // the card aggregate never runs guardTransferMutability (ADR-020 §3/§4).
    expect(error.issues?.[0]).toContain('revert_bill_payment');
    expect(error.issues?.[0]).not.toContain('cannot change the type of a transfer');
  });

  it('deleteCardTransaction rejects it via the paid-bill immutability guard', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => paymentTransfer } as unknown as Deps['transactions'],
      accounts: { findById } as unknown as Deps['accounts'],
      bills: {
        findById: async () => ({ id: 'bill-1', status: BillStatus.enum.paid }),
      } as unknown as Deps['bills'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('validation');
    expect(error.issues?.[0]).toContain('revert_bill_payment');
  });
});

const cardOwnedTx: RawTransactionView = {
  ...baseTx,
  accountId: 'acc-card-internal',
  cardId: 'card-1',
  billId: 'bill-1',
};
const creditAccountsById = {
  findById: async () => account({ id: 'acc-card-internal', type: AccountType.enum.credit }),
};

describe('updateCardTransaction — bill reassignment is returned as data (ADR-021 phase 2b)', () => {
  it('a plain, non-reassignment edit emits only the transaction update — no bill read at all', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      // Throwing stand-ins prove these are never called for a non-reassignment update — matches
      // the pre-conversion behavior, where only billMonth/billYear reassignment ever reads a bill.
      bills: {
        findById: () => {
          throw new Error('must not read a bill for a non-reassignment update');
        },
        findByCycle: () => {
          throw new Error('must not read a bill for a non-reassignment update');
        },
      } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', amount: 99 });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.update, entity: 'transaction' });
  });

  it('reassigning to a different open target emits: target touch, current touch, transaction update', async () => {
    const currentBill = rawBill({ id: 'bill-1', month: 6, year: 2026, version: 2 });
    const targetBill = rawBill({ id: 'bill-2', month: 7, year: 2026, version: 5 });
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      creditCards: { findById: async () => card() } as unknown as Deps['creditCards'],
      bills: {
        findById: async () => currentBill,
        findByCycle: async () => targetBill,
      } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', billMonth: 7, billYear: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(3);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-2', version: 5 },
    });
    expect(persist[1]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: 2 },
    });
    expect(persist[2]).toMatchObject({ op: PersistOp.enum.update, entity: 'transaction' });
    const txModel = (persist[2] as { model: { refs: { billId?: string } } }).model;
    expect(txModel.refs.billId).toBe('bill-2');
  });

  it('reassigning onto a not-yet-existing target cycle emits a bill insert, not a touch', async () => {
    const currentBill = rawBill({ id: 'bill-1', month: 6, year: 2026, version: 2 });
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      creditCards: { findById: async () => card() } as unknown as Deps['creditCards'],
      bills: {
        findById: async () => currentBill,
        findByCycle: async () => null,
      } as unknown as Deps['bills'],
      newId: sequentialNewId(),
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', billMonth: 8, billYear: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(3);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.insert, entity: 'bill' });
  });

  it('reassigning onto the SAME cycle it is already on emits one touch, not two', async () => {
    const currentBill = rawBill({ id: 'bill-1', month: 6, year: 2026, version: 2 });
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      creditCards: { findById: async () => card() } as unknown as Deps['creditCards'],
      bills: {
        findById: async () => currentBill,
        findByCycle: async () => currentBill,
      } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', billMonth: 6, billYear: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.update, entity: 'bill', model: { id: 'bill-1' } });
    expect(persist[1]).toMatchObject({ op: PersistOp.enum.update, entity: 'transaction' });
  });

  it('rejects when the CURRENT bill is paid', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      bills: { findById: async () => rawBill({ status: BillStatus.enum.paid }) } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', billMonth: 7, billYear: 2026 });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().issues?.[0]).toContain('revert_bill_payment');
  });

  it('rejects when the TARGET bill is paid', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      creditCards: { findById: async () => card() } as unknown as Deps['creditCards'],
      bills: {
        findById: async () => rawBill({ id: 'bill-1' }),
        findByCycle: async () => rawBill({ id: 'bill-2', status: BillStatus.enum.paid }),
      } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', billMonth: 7, billYear: 2026 });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().issues?.[0]).toContain('revert_bill_payment');
  });

  it("response() resolves the LAST persist outcome (the transaction's), not the first", async () => {
    const currentBill = rawBill({ id: 'bill-1', month: 6, year: 2026, version: 2 });
    const targetBill = rawBill({ id: 'bill-2', month: 7, year: 2026, version: 5 });
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      creditCards: { findById: async () => card() } as unknown as Deps['creditCards'],
      bills: { findById: async () => currentBill, findByCycle: async () => targetBill } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', billMonth: 7, billYear: 2026 });
    const outcome = result._unsafeUnwrap();
    expect(typeof outcome.response).toBe('function');

    const txOutcome: PersistOutcome = { applied: true, read: { ...cardOwnedTx, description: 'Reassigned' } };
    const response = (outcome.response as (outcomes: PersistOutcome[]) => { description: string })([
      { applied: true },
      { applied: true },
      txOutcome,
    ]);
    expect(response.description).toBe('Reassigned');
  });
});

const newCategory = { id: 'cat-new', name: 'Transporte', kind: 'both', names: null };

describe('updateCardTransaction — merchant learning (ADR-021 rule 5)', () => {
  it('composes a merchant-learning insert into the same atomic batch, before the transaction update', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...cardOwnedTx, categoryId: 'cat-old', merchant: 'uber' }),
      } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      categories: { list: async () => [newCategory] } as unknown as Deps['categories'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', category: 'Transporte' });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toEqual({
      op: PersistOp.enum.insert,
      entity: 'merchantCategory',
      model: { merchantKey: 'uber', categoryId: 'cat-new' },
    });
    expect(persist[1]).toMatchObject({ op: PersistOp.enum.update, entity: 'transaction' });
  });

  it('does not append a merchant-learning Persistable when no category correction was given', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...cardOwnedTx, categoryId: 'cat-old', merchant: 'uber' }),
      } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', description: 'No category change' });

    expect(result._unsafeUnwrap().persist).toHaveLength(1);
  });

  it('does not append a merchant-learning Persistable when the transaction has no classified merchant', async () => {
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...cardOwnedTx, categoryId: 'cat-old', merchant: undefined }),
      } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      categories: { list: async () => [newCategory] } as unknown as Deps['categories'],
    });

    const result = await updateCardTransaction(deps, { id: 'tx-1', category: 'Transporte' });

    expect(result._unsafeUnwrap().persist).toHaveLength(1);
  });

  it('places the merchant-learning insert BEFORE the transaction update even when reassigning bills too', async () => {
    const currentBill = rawBill({ id: 'bill-1', month: 6, year: 2026, version: 2 });
    const deps = makeDeps({
      transactions: {
        getById: async () => ({ ...cardOwnedTx, categoryId: 'cat-old', merchant: 'uber' }),
      } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      categories: { list: async () => [newCategory] } as unknown as Deps['categories'],
      creditCards: { findById: async () => card() } as unknown as Deps['creditCards'],
      bills: {
        findById: async () => currentBill,
        findByCycle: async () => currentBill,
      } as unknown as Deps['bills'],
    });

    const result = await updateCardTransaction(deps, {
      id: 'tx-1',
      category: 'Transporte',
      billMonth: 6,
      billYear: 2026,
    });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    // Same-cycle reassignment dedupes to one bill touch: bill touch, merchant-learning insert,
    // transaction update — in that order (transaction always last, see lastOutcome).
    expect(persist).toHaveLength(3);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.update, entity: 'bill' });
    expect(persist[1]).toMatchObject({ op: PersistOp.enum.insert, entity: 'merchantCategory' });
    expect(persist[2]).toMatchObject({ op: PersistOp.enum.update, entity: 'transaction' });
  });
});

describe('deleteCardTransaction — guards + is returned as data (ADR-021 phase 2b)', () => {
  it('dry run (no confirm) returns an empty persist batch — no bill read needed', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      bills: { findById: async () => rawBill() } as unknown as Deps['bills'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: false });

    expect(result.isOk()).toBe(true);
    const outcome = result._unsafeUnwrap();
    expect(outcome.persist).toEqual([]);
    expect(outcome.response).toMatchObject({ deleted: false, dryRun: true });
  });

  it('confirmed delete emits a version-guarded bill touch before the transaction remove', async () => {
    const bill = rawBill({ id: 'bill-1', version: 4 });
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      bills: { findById: async () => bill } as unknown as Deps['bills'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: 4 },
    });
    expect(persist[1]).toEqual({
      op: PersistOp.enum.delete,
      entity: 'transaction',
      id: 'tx-1',
      version: cardOwnedTx.version,
    });
  });

  it('rejects deleting a transaction whose bill is paid', async () => {
    const deps = makeDeps({
      transactions: { getById: async () => cardOwnedTx } as unknown as Deps['transactions'],
      accounts: creditAccountsById as unknown as Deps['accounts'],
      bills: { findById: async () => rawBill({ status: BillStatus.enum.paid }) } as unknown as Deps['bills'],
    });

    const result = await deleteCardTransaction(deps, { id: 'tx-1', confirm: true });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().issues?.[0]).toContain('revert_bill_payment');
  });
});
