import { describe, expect, it, vi } from 'vitest';
import { payBill, revertBillPayment } from '../../../../src/controllers/creditCard/bill.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import { BillStatus, type RawBill } from '../../../../src/models/bill.js';
import type { BillWithItems } from '../../../../src/diplomat/db/repos/bills.js';
import type { CreditCard } from '../../../../src/models/creditCard.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';
import { toIsoDate } from '../../../../src/logic/period.js';
import { PersistOp } from '../../../../src/models/persistable.js';
import { TransactionSource, type RawTransactionView } from '../../../../src/models/transaction.js';

const account = (overrides: Partial<Account> = {}): Account => ({
  id: 'acc-checking',
  name: 'Checking',
  type: AccountType.enum.checking,
  currency: CurrencyCode.enum.USD,
  initialBalance: 0,
  ...overrides,
});

const card = (overrides: Partial<CreditCard> = {}): CreditCard => ({
  id: 'card-1',
  name: 'Test Card',
  currency: CurrencyCode.enum.USD,
  closingDay: 28,
  dueDay: 5,
  accountId: 'acc-card-internal',
  paymentAccountId: 'acc-checking',
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

const billItem = (overrides: Partial<RawTransactionView> = {}): RawTransactionView => ({
  id: 'purchase-1',
  description: 'Purchase',
  amount: 100,
  type: 'expense',
  status: 'effective',
  date: '2026-06-01',
  currency: 'USD',
  source: 'mcp',
  idempotencyKey: 'k',
  classification: { method: 'none', confidence: 0 },
  tags: [],
  version: 0,
  ...overrides,
});

const billWithItems = (overrides: Partial<BillWithItems> = {}): BillWithItems => ({
  bill: {
    id: 'bill-1',
    month: 6,
    year: 2026,
    closeDate: '2026-06-28',
    dueDate: '2026-07-05',
    status: BillStatus.enum.open,
  },
  cardName: 'Test Card',
  transactions: [billItem()],
  ...overrides,
});

const makeDeps = (overrides: Partial<Deps> = {}): Deps => ({
  accounts: { list: async () => [account()], findById: async () => account() } as unknown as Deps['accounts'],
  bills: {} as Deps['bills'],
  budgets: {} as Deps['budgets'],
  categories: {} as Deps['categories'],
  subCategories: {} as Deps['subCategories'],
  correlations: {} as Deps['correlations'],
  creditCards: { list: async () => [card()] } as unknown as Deps['creditCards'],
  currencies: {} as Deps['currencies'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  clock: () => new Date('2026-06-15'),
  newId: () => 'new-tx-id',
  locale: async () => Locale.enum.en,
  ...overrides,
});

describe('payBill — the write is returned as data, not performed (ADR-021 phase 2c)', () => {
  it('a positive total emits [payment-transfer insert, version-guarded bill update]', async () => {
    const bill = rawBill();
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findById: async () => bill } as unknown as Deps['bills'],
    });

    const result = await payBill(deps, { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.insert, entity: 'transaction' });
    const txModel = (
      persist[0] as {
        model: {
          amount: number;
          refs: { accountId?: string; toAccountId?: string; billId?: string };
          idempotencyKey: string;
        };
      }
    ).model;
    expect(txModel.amount).toBe(100);
    expect(txModel.idempotencyKey).toBe('billpay-bill-1');
    expect(txModel.refs).toMatchObject({
      accountId: 'acc-checking',
      toAccountId: 'acc-card-internal',
      billId: 'bill-1',
    });

    expect(persist[1]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: bill.version, status: BillStatus.enum.paid, paymentTransactionId: 'new-tx-id' },
    });

    expect(response).toMatchObject({ status: BillStatus.enum.paid, paymentTransactionId: 'new-tx-id' });
  });

  it('a non-positive total emits only a version-guarded bill update, no transfer', async () => {
    const bill = rawBill();
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems({ transactions: [billItem({ type: 'income', amount: 30 })] }),
        findById: async () => bill,
      } as unknown as Deps['bills'],
    });

    const result = await payBill(deps, { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: bill.version, status: BillStatus.enum.paid },
    });
    const billModel = (persist[0] as { model: { paymentTransactionId?: string } }).model;
    expect(billModel.paymentTransactionId).toBeUndefined();
    expect(response).toMatchObject({ status: BillStatus.enum.paid });
    expect((response as { paymentTransactionId?: string }).paymentTransactionId).toBeUndefined();
  });

  it('an already-paid bill is idempotent: empty persist, the existing bill as response', async () => {
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems({ bill: { ...billWithItems().bill, status: BillStatus.enum.paid } }),
        findById: async () => {
          throw new Error('must not read version for an already-paid bill — no write to build');
        },
      } as unknown as Deps['bills'],
    });

    const result = await payBill(deps, { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toEqual([]);
    expect(response).toMatchObject({ status: BillStatus.enum.paid });
  });

  it('rejects a credit-type payer before building any write', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findById: async () => rawBill() } as unknown as Deps['bills'],
      accounts: {
        list: async () => [account()],
        findById: async () => account({ id: 'acc-card-internal', type: AccountType.enum.credit }),
      } as unknown as Deps['accounts'],
      creditCards: {
        list: async () => [card({ paymentAccountId: 'acc-card-internal' })],
      } as unknown as Deps['creditCards'],
    });

    const result = await payBill(deps, { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a currency-mismatched payer before building any write', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findById: async () => rawBill() } as unknown as Deps['bills'],
      accounts: { list: async () => [account({ currency: CurrencyCode.enum.BRL })] } as unknown as Deps['accounts'],
    });

    const result = await payBill(deps, {
      card: 'Test Card',
      month: 6,
      year: 2026,
      account: 'Checking',
      source: TransactionSource.enum.mcp,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  const clockDate = new Date(2026, 5, 15); // local-time constructor — avoids UTC/local drift
  const today = toIsoDate(clockDate);
  const pastDate = toIsoDate(new Date(2026, 5, 10));
  const futureDate = toIsoDate(new Date(2026, 5, 16));
  const rejectedPaymentDateReadsVersion = () => {
    throw new Error('must not read version for a rejected paymentDate — no write to build');
  };

  it('an explicit past paymentDate dates the transfer then, effective', async () => {
    const bill = rawBill();
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findById: async () => bill } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const result = await payBill(deps, {
      card: 'Test Card',
      month: 6,
      year: 2026,
      paymentDate: pastDate,
      source: TransactionSource.enum.mcp,
    });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    const txModel = (persist[0] as { model: { date: string; status: string } }).model;
    expect(txModel.date).toBe(pastDate);
    expect(txModel.status).toBe('effective');
  });

  it('an omitted paymentDate defaults to today (the clock date)', async () => {
    const bill = rawBill();
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findById: async () => bill } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const result = await payBill(deps, { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp });

    expect(result.isOk()).toBe(true);
    const { persist } = result._unsafeUnwrap();
    const txModel = (persist[0] as { model: { date: string } }).model;
    expect(txModel.date).toBe(today);
  });

  it('rejects a future paymentDate before reading the bill version to build any write', async () => {
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems(),
        findById: rejectedPaymentDateReadsVersion,
      } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const result = await payBill(deps, {
      card: 'Test Card',
      month: 6,
      year: 2026,
      paymentDate: futureDate,
      source: TransactionSource.enum.mcp,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a future paymentDate even when the bill total is non-positive (no transfer branch)', async () => {
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems({ transactions: [billItem({ type: 'income', amount: 30 })] }),
        findById: rejectedPaymentDateReadsVersion,
      } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const result = await payBill(deps, {
      card: 'Test Card',
      month: 6,
      year: 2026,
      paymentDate: futureDate,
      source: TransactionSource.enum.mcp,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects when neither an explicit account nor a card default payer is available', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findById: async () => rawBill() } as unknown as Deps['bills'],
      creditCards: { list: async () => [card({ paymentAccountId: undefined })] } as unknown as Deps['creditCards'],
    });

    const result = await payBill(deps, { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('revertBillPayment — the write is returned as data, not performed (ADR-021 phase 2c)', () => {
  it('a paid bill with a transfer emits [version-guarded bill update, version-guarded transfer remove]', async () => {
    const paidBill = rawBill({ status: BillStatus.enum.paid, paymentTransactionId: 'tx-payment' });
    const paymentTx: RawTransactionView = { ...billItem({ id: 'tx-payment', type: 'transfer' }), version: 7 };
    const deps = makeDeps({
      bills: {
        get: async () =>
          billWithItems({
            bill: { ...billWithItems().bill, status: BillStatus.enum.paid, paymentTransactionId: 'tx-payment' },
          }),
        findById: async () => paidBill,
      } as unknown as Deps['bills'],
      transactions: { getById: async () => paymentTx } as unknown as Deps['transactions'],
    });

    const result = await revertBillPayment(deps, { card: 'Test Card', month: 6, year: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: paidBill.version, status: BillStatus.enum.closed, paymentTransactionId: null },
    });
    expect(persist[1]).toEqual({ op: PersistOp.enum.delete, entity: 'transaction', id: 'tx-payment', version: 7 });
    expect(response).toMatchObject({ status: BillStatus.enum.closed });
    expect((response as { paymentTransactionId?: string }).paymentTransactionId).toBeUndefined();
  });

  it('a paymentTransactionId that no longer resolves is treated as nothing to delete', async () => {
    const paidBill = rawBill({ status: BillStatus.enum.paid, paymentTransactionId: 'tx-payment' });
    const deps = makeDeps({
      bills: {
        get: async () =>
          billWithItems({
            bill: { ...billWithItems().bill, status: BillStatus.enum.paid, paymentTransactionId: 'tx-payment' },
          }),
        findById: async () => paidBill,
      } as unknown as Deps['bills'],
      transactions: { getById: async () => null } as unknown as Deps['transactions'],
    });

    const result = await revertBillPayment(deps, { card: 'Test Card', month: 6, year: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', status: BillStatus.enum.closed },
    });
    expect(response).toMatchObject({ status: BillStatus.enum.closed });
  });

  it('a paid bill with no payment transfer (non-positive-total pay) emits only the bill update', async () => {
    const paidBill = rawBill({ status: BillStatus.enum.paid, paymentTransactionId: undefined });
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems({ bill: { ...billWithItems().bill, status: BillStatus.enum.paid } }),
        findById: async () => paidBill,
      } as unknown as Deps['bills'],
      transactions: {
        getById: async () => {
          throw new Error('must not read a payment transaction that was never created');
        },
      } as unknown as Deps['transactions'],
    });

    const result = await revertBillPayment(deps, { card: 'Test Card', month: 6, year: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', status: BillStatus.enum.closed },
    });
    expect(response).toMatchObject({ status: BillStatus.enum.closed });
  });

  it('a bill that is not paid is idempotent: empty persist, the existing bill as response', async () => {
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems(),
        findById: async () => {
          throw new Error('must not read version for a not-paid bill — no write to build');
        },
      } as unknown as Deps['bills'],
    });

    const result = await revertBillPayment(deps, { card: 'Test Card', month: 6, year: 2026 });

    expect(result.isOk()).toBe(true);
    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toEqual([]);
    expect(response).toMatchObject({ status: BillStatus.enum.open });
  });
});
