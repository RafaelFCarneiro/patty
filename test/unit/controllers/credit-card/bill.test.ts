import { describe, expect, it } from 'vitest';
import { payBill, revertBillPayment } from '../../../../src/controllers/credit-card/bill.js';
import type { Deps } from '../../../../src/controllers/deps.js';
import { AccountType, type Account } from '../../../../src/models/account.js';
import { BillStatus, type RawBill } from '../../../../src/models/bill.js';
import type { BillWithItems } from '../../../../src/diplomat/db/repos/bills.js';
import type { CreditCard } from '../../../../src/models/credit-card.js';
import { CurrencyCode } from '../../../../src/models/money.js';
import { Locale } from '../../../../src/models/locale.js';
import { toIsoDate } from '../../../../src/logic/period.js';
import { billPaymentKey } from '../../../../src/logic/bill.js';
import { PersistOp } from '@rfc0/effect-runner';
import { TransactionSource, TransactionType, type RawTransactionView } from '../../../../src/models/transaction.js';

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

const paymentItem = (overrides: Partial<RawTransactionView> = {}): RawTransactionView =>
  billItem({
    id: 'tx-payment',
    description: 'Bill payment',
    type: TransactionType.enum.transfer,
    amount: 60,
    date: '2026-06-10',
    accountName: 'Checking',
    toAccountId: 'acc-card-internal',
    billId: 'bill-1',
    version: 7,
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
  currencies: { list: async () => [] } as unknown as Deps['currencies'],
  currencyRates: {} as Deps['currencyRates'],
  dashboards: {} as Deps['dashboards'],
  health: {} as Deps['health'],
  instance: {} as Deps['instance'],
  merchants: {} as Deps['merchants'],
  recurring: {} as Deps['recurring'],
  settings: {} as Deps['settings'],
  tags: {} as Deps['tags'],
  transactions: {} as Deps['transactions'],
  assets: {} as Deps['assets'],
  assetPrices: {} as Deps['assetPrices'],
  investments: {} as Deps['investments'],
  clock: () => new Date('2026-06-15'),
  newId: () => 'new-tx-id',
  locale: async () => Locale.enum.en,
  rateStaleness: { fiatHours: 24, cryptoHours: 1 },
  priceStaleness: { marketHours: 72, manualDays: 31 },
  ...overrides,
});

const defaultToday = toIsoDate(new Date('2026-06-15')); // the clock `makeDeps` injects

const pay = { card: 'Test Card', month: 6, year: 2026, source: TransactionSource.enum.mcp } as const;

const billsDeps = (items: RawTransactionView[], bill: RawBill = rawBill(), status: BillStatus = bill.status) =>
  makeDeps({
    bills: {
      get: async () => billWithItems({ bill: { ...billWithItems().bill, status }, transactions: items }),
      findByCycle: async () => bill,
    } as unknown as Deps['bills'],
  });

type BillModel = { id: string; version: number; status: BillStatus };
type TransferModel = { amount: number; refs: { accountId?: string; toAccountId?: string; billId?: string } };

describe('payBill — the write is returned as data, not performed (ADR-021 phase 2c)', () => {
  it('without an amount it pays what remains: [transfer insert, version-guarded bill update to paid]', async () => {
    const bill = rawBill();
    const result = await payBill(billsDeps([billItem()], bill), pay);

    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.insert, entity: 'transaction' });
    const insert = persist[0] as { idempotencyKey: string; model: TransferModel };
    expect(insert.idempotencyKey).toBe(
      billPaymentKey({ bill, date: defaultToday, amount: 100, decimals: 2, discriminator: undefined }),
    );
    expect(insert.model.amount).toBe(100);
    expect(insert.model.refs).toEqual({
      accountId: 'acc-checking',
      toAccountId: 'acc-card-internal',
      billId: 'bill-1',
    });
    expect(persist[1]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: bill.version, status: BillStatus.enum.paid },
    });
    expect(response).toMatchObject({
      status: BillStatus.enum.paid,
      paidAmount: 100,
      remaining: 0,
      partiallyPaid: false,
      paymentTransactionId: 'new-tx-id',
      payments: [{ id: 'new-tx-id', date: defaultToday, amount: 100, account: 'Checking' }],
    });
  });

  it('a payment below the remaining keeps the bill status and still version-guards the bill', async () => {
    const bill = rawBill({ status: BillStatus.enum.closed });
    const result = await payBill(billsDeps([billItem()], bill), { ...pay, amount: 40 });

    const { persist, response } = result._unsafeUnwrap();
    expect((persist[0] as { model: TransferModel }).model.amount).toBe(40);
    expect(persist[1]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: bill.version, status: BillStatus.enum.closed },
    });
    expect(response).toMatchObject({
      status: BillStatus.enum.closed,
      paidAmount: 40,
      remaining: 60,
      partiallyPaid: true,
    });
  });

  it('a second payment that brings the remaining to 0 settles the bill', async () => {
    const result = await payBill(billsDeps([billItem(), paymentItem({ amount: 60 })]), pay);

    const { persist, response } = result._unsafeUnwrap();
    expect((persist[0] as { model: TransferModel }).model.amount).toBe(40);
    expect((persist[1] as { model: BillModel }).model.status).toBe(BillStatus.enum.paid);
    expect(response).toMatchObject({ status: BillStatus.enum.paid, paidAmount: 100, remaining: 0 });
    expect((response as { payments: unknown[] }).payments).toHaveLength(2);
  });

  it('an amount above what remains is refused, naming the remaining amount', async () => {
    const result = await payBill(billsDeps([billItem(), paymentItem({ amount: 60 })]), { ...pay, amount: 41 });

    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'validation',
      issues: ['amount exceeds what remains on the bill (40)'],
    });
  });

  it('an amount that rounds to nothing in the card currency is refused', async () => {
    const result = await payBill(billsDeps([billItem()]), { ...pay, amount: 0.001 });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('repeating the same bill, date and amount is a no-op, even when it would now exceed the remaining', async () => {
    const bill = rawBill();
    const key = billPaymentKey({ bill, date: defaultToday, amount: 70, decimals: 2, discriminator: undefined });
    const items = [billItem(), paymentItem({ amount: 70, date: defaultToday, idempotencyKey: key })];

    const result = await payBill(billsDeps(items, bill), { ...pay, amount: 70 });

    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toEqual([]);
    expect(response).toMatchObject({ paidAmount: 70, remaining: 30, partiallyPaid: true });
  });

  it('a discriminator makes the same bill, date and amount a second payment', async () => {
    const bill = rawBill();
    const key = billPaymentKey({ bill, date: defaultToday, amount: 30, decimals: 2, discriminator: undefined });
    const items = [billItem(), paymentItem({ amount: 30, date: defaultToday, idempotencyKey: key })];

    const result = await payBill(billsDeps(items, bill), { ...pay, amount: 30, discriminator: 'second' });

    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(2);
    expect((persist[0] as { idempotencyKey: string }).idempotencyKey).not.toBe(key);
    expect(response).toMatchObject({ paidAmount: 60, remaining: 40 });
  });

  it('a non-positive remaining emits only a version-guarded bill update to paid, no transfer', async () => {
    const bill = rawBill();
    const result = await payBill(billsDeps([billItem({ type: 'income', amount: 30 })], bill), pay);

    const { persist, response } = result._unsafeUnwrap();
    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({
      op: PersistOp.enum.update,
      entity: 'bill',
      model: { id: 'bill-1', version: bill.version, status: BillStatus.enum.paid },
    });
    expect(response).toMatchObject({ status: BillStatus.enum.paid, payments: [] });
    expect((response as { paymentTransactionId?: string }).paymentTransactionId).toBeUndefined();
  });

  it('an already-paid bill is idempotent: empty persist, the settled bill as response', async () => {
    const deps = makeDeps({
      bills: {
        get: async () =>
          billWithItems({
            bill: { ...billWithItems().bill, status: BillStatus.enum.paid },
            transactions: [billItem(), paymentItem({ amount: 100 })],
          }),
        findByCycle: async () => rawBill(),
      } as unknown as Deps['bills'],
    });

    const { persist, response } = (await payBill(deps, pay))._unsafeUnwrap();

    expect(persist).toEqual([]);
    expect(response).toMatchObject({
      status: BillStatus.enum.paid,
      paidAmount: 100,
      paymentTransactionId: 'tx-payment',
    });
  });

  it('rejects a credit-type payer before building any write', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findByCycle: async () => rawBill() } as unknown as Deps['bills'],
      accounts: {
        list: async () => [account()],
        findById: async () => account({ id: 'acc-card-internal', type: AccountType.enum.credit }),
      } as unknown as Deps['accounts'],
      creditCards: {
        list: async () => [card({ paymentAccountId: 'acc-card-internal' })],
      } as unknown as Deps['creditCards'],
    });

    const result = await payBill(deps, pay);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a currency-mismatched payer before building any write', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findByCycle: async () => rawBill() } as unknown as Deps['bills'],
      accounts: { list: async () => [account({ currency: CurrencyCode.enum.BRL })] } as unknown as Deps['accounts'],
    });

    const result = await payBill(deps, { ...pay, account: 'Checking' });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  const clockDate = new Date(2026, 5, 15); // local-time constructor — avoids UTC/local drift
  const today = toIsoDate(clockDate);
  const pastDate = toIsoDate(new Date(2026, 5, 10));
  const futureDate = toIsoDate(new Date(2026, 5, 16));

  it('an explicit past paymentDate dates the transfer then, effective', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findByCycle: async () => rawBill() } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const { persist } = (await payBill(deps, { ...pay, paymentDate: pastDate }))._unsafeUnwrap();

    const txModel = (persist[0] as { model: { date: string; status: string } }).model;
    expect(txModel.date).toBe(pastDate);
    expect(txModel.status).toBe('effective');
  });

  it('an omitted paymentDate defaults to today (the clock date)', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findByCycle: async () => rawBill() } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const { persist } = (await payBill(deps, pay))._unsafeUnwrap();

    expect((persist[0] as { model: { date: string } }).model.date).toBe(today);
  });

  it.each([
    ['a positive remaining', [billItem()]],
    ['a non-positive remaining', [billItem({ type: 'income', amount: 30 })]],
  ])('rejects a future paymentDate, with %s', async (_label, items) => {
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems({ transactions: items }),
        findByCycle: async () => rawBill(),
      } as unknown as Deps['bills'],
      clock: () => clockDate,
    });

    const result = await payBill(deps, { ...pay, paymentDate: futureDate });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects when neither an explicit account nor a card default payer is available', async () => {
    const deps = makeDeps({
      bills: { get: async () => billWithItems(), findByCycle: async () => rawBill() } as unknown as Deps['bills'],
      creditCards: { list: async () => [card({ paymentAccountId: undefined })] } as unknown as Deps['creditCards'],
    });

    const result = await payBill(deps, pay);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('revertBillPayment — the write is returned as data, not performed (ADR-021 phase 2c)', () => {
  const revert = { card: 'Test Card', month: 6, year: 2026 };
  const older = paymentItem({ id: 'tx-old', date: '2026-06-05', amount: 60, version: 3 });
  const newer = paymentItem({ id: 'tx-new', date: '2026-06-12', amount: 40, version: 9 });

  it('a paid bill with one payment emits [version-guarded bill update to closed, transfer remove]', async () => {
    const paidBill = rawBill({ status: BillStatus.enum.paid });
    const items = [billItem(), paymentItem({ amount: 100 })];

    const { persist, response } = (await revertBillPayment(billsDeps(items, paidBill), revert))._unsafeUnwrap();

    expect(persist).toEqual([
      {
        op: PersistOp.enum.update,
        entity: 'bill',
        model: expect.objectContaining({ id: 'bill-1', version: paidBill.version, status: BillStatus.enum.closed }),
      },
      { op: PersistOp.enum.delete, entity: 'transaction', id: 'tx-payment', version: 7 },
    ]);
    expect(response).toMatchObject({ status: BillStatus.enum.closed, paidAmount: 0, remaining: 100, payments: [] });
    expect((response as { paymentTransactionId?: string }).paymentTransactionId).toBeUndefined();
  });

  it('with a paymentId it undoes that payment and keeps a part-paid bill status', async () => {
    const bill = rawBill({ status: BillStatus.enum.closed });

    const { persist, response } = (
      await revertBillPayment(billsDeps([billItem(), older, newer], bill), { ...revert, paymentId: 'tx-new' })
    )._unsafeUnwrap();

    expect(persist[1]).toEqual({ op: PersistOp.enum.delete, entity: 'transaction', id: 'tx-new', version: 9 });
    expect((persist[0] as { model: BillModel }).model.status).toBe(BillStatus.enum.closed);
    expect(response).toMatchObject({
      paidAmount: 60,
      remaining: 40,
      partiallyPaid: true,
      paymentTransactionId: 'tx-old',
    });
  });

  it('without a paymentId it undoes the bill’s only payment', async () => {
    const result = await revertBillPayment(billsDeps([billItem(), older]), revert);

    expect(result._unsafeUnwrap().persist[1]).toMatchObject({ op: PersistOp.enum.delete, id: 'tx-old' });
  });

  it('with a paymentId it undoes that payment', async () => {
    const result = await revertBillPayment(billsDeps([billItem(), older, newer]), { ...revert, paymentId: 'tx-old' });

    expect(result._unsafeUnwrap().persist[1]).toMatchObject({ op: PersistOp.enum.delete, id: 'tx-old' });
  });

  it('undoing one of two payments of a paid bill flips it back to closed', async () => {
    const paidBill = rawBill({ status: BillStatus.enum.paid });

    const { persist, response } = (
      await revertBillPayment(billsDeps([billItem(), older, newer], paidBill), { ...revert, paymentId: 'tx-new' })
    )._unsafeUnwrap();

    expect((persist[0] as { model: BillModel }).model.status).toBe(BillStatus.enum.closed);
    expect(response).toMatchObject({ status: BillStatus.enum.closed, remaining: 40 });
  });

  it('refuses without a paymentId when the bill has several payments, listing their ids', async () => {
    const result = await revertBillPayment(billsDeps([billItem(), older, newer]), revert);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: 'validation',
      issues: ['the bill has several payments: pass `paymentId` — one of tx-old, tx-new'],
    });
  });

  it('a paymentId that is not a payment of the bill answers the bill unchanged, removing nothing', async () => {
    const { persist, response } = (
      await revertBillPayment(billsDeps([billItem(), older]), { ...revert, paymentId: 'tx-elsewhere' })
    )._unsafeUnwrap();

    expect(persist).toEqual([]);
    expect(response).toMatchObject({ paidAmount: 60, remaining: 40 });
  });

  it('repeating an undo with the same id is unchanged once the payment is gone', async () => {
    const { persist } = (
      await revertBillPayment(billsDeps([billItem()]), { ...revert, paymentId: 'tx-old' })
    )._unsafeUnwrap();

    expect(persist).toEqual([]);
  });

  it('a paid bill with no payment transfer emits only the bill update to closed', async () => {
    const paidBill = rawBill({ status: BillStatus.enum.paid });

    const { persist, response } = (
      await revertBillPayment(billsDeps([billItem({ type: 'income', amount: 30 })], paidBill), revert)
    )._unsafeUnwrap();

    expect(persist).toHaveLength(1);
    expect(persist[0]).toMatchObject({ op: PersistOp.enum.update, entity: 'bill', model: { status: 'closed' } });
    expect(response).toMatchObject({ status: BillStatus.enum.closed });
  });

  it('a bill with no payment is idempotent: empty persist, the settled bill as response', async () => {
    const deps = makeDeps({
      bills: {
        get: async () => billWithItems(),
        findByCycle: async () => rawBill(),
      } as unknown as Deps['bills'],
    });

    const { persist, response } = (await revertBillPayment(deps, revert))._unsafeUnwrap();

    expect(persist).toEqual([]);
    expect(response).toMatchObject({ status: BillStatus.enum.open, paidAmount: 0, remaining: 100, payments: [] });
  });
});
