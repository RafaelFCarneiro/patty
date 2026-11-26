import { describe, expect, it } from 'vitest';
import { BillStatus, type Bill } from '../../../src/models/bill.js';
import { CurrencyCode } from '../../../src/models/money.js';
import { Locale } from '../../../src/models/locale.js';
import {
  ClassificationMethod,
  TransactionSource,
  TransactionStatus,
  TransactionType,
  TransactionViewSchema,
  type TransactionView,
} from '../../../src/models/transaction.js';
import {
  assertBillPeriodPaired,
  billPeriodFor,
  billPeriodForCycle,
  computeBillTotal,
  billPaymentDescription,
  billPaymentKey,
  coversPaid,
  hasIdempotencyKey,
  paymentsOf,
  paymentsOnLatestDate,
  settlement,
  toSettledBill,
  totalAfterChange,
  billPeriodKey,
  isBillPaid,
  planBillPayment,
  resolveBillPeriod,
  withBillId,
  withStatusLabel,
} from '../../../src/logic/bill.js';

const tx = (type: TransactionType, amount: number): TransactionView =>
  TransactionViewSchema.parse({
    id: crypto.randomUUID(),
    description: 'test',
    amount,
    type,
    status: TransactionStatus.enum.effective,
    date: '2026-06-01',
    currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp,
    idempotencyKey: `k-${amount}-${type}`,
    classification: { method: ClassificationMethod.enum.none, confidence: 0 },
  });

describe('computeBillTotal', () => {
  const { expense, income, transfer } = TransactionType.enum;

  it('sums expenses as positive', () => {
    expect(computeBillTotal([tx(expense, 100), tx(expense, 50)])).toBe(150);
  });

  it('subtracts income (refunds/credits) from the total', () => {
    expect(computeBillTotal([tx(expense, 100), tx(income, 30)])).toBe(70);
  });

  it('excludes transfers from the total', () => {
    expect(computeBillTotal([tx(expense, 100), tx(transfer, 200)])).toBe(100);
  });

  it('returns 0 for an empty bill', () => {
    expect(computeBillTotal([])).toBe(0);
  });
});

describe('billPeriodFor', () => {
  // card closes on the 20th, due on the 5th of the following month
  it('assigns transaction before closing day to current month bill', () => {
    expect(billPeriodFor('2026-06-15', 20, 5)).toEqual({
      month: 6,
      year: 2026,
      closeDate: '2026-06-20',
      dueDate: '2026-07-05',
    });
  });

  it('assigns transaction on the closing day to next month bill', () => {
    expect(billPeriodFor('2026-06-20', 20, 5)).toEqual({
      month: 7,
      year: 2026,
      closeDate: '2026-07-20',
      dueDate: '2026-08-05',
    });
  });

  it('assigns transaction after closing day to next month bill', () => {
    expect(billPeriodFor('2026-06-21', 20, 5)).toEqual({
      month: 7,
      year: 2026,
      closeDate: '2026-07-20',
      dueDate: '2026-08-05',
    });
  });

  it('rolls December into January', () => {
    expect(billPeriodFor('2026-12-25', 20, 5)).toMatchObject({ month: 1, year: 2027, dueDate: '2027-02-05' });
  });

  it('keeps due date in same month when dueDay > closingDay', () => {
    // closes on the 5th, due on the 15th of the same month
    expect(billPeriodFor('2026-06-03', 5, 15)).toEqual({
      month: 6,
      year: 2026,
      closeDate: '2026-06-05',
      dueDate: '2026-06-15',
    });
  });

  it('assigns transaction on the closing day to next month bill when dueDay > closingDay', () => {
    // closes on the 5th, due on the 15th of the same month; on-closing-day goes to next cycle
    expect(billPeriodFor('2026-06-05', 5, 15)).toEqual({
      month: 7,
      year: 2026,
      closeDate: '2026-07-05',
      dueDate: '2026-07-15',
    });
  });
});

describe('billPeriodForCycle', () => {
  // Same close/due-date math as billPeriodFor, but the target cycle is already known
  // (a manual bill assignment) rather than derived from a transaction date.
  it('computes close/due dates for an explicit month/year', () => {
    expect(billPeriodForCycle(6, 2026, 20, 5)).toEqual({
      month: 6,
      year: 2026,
      closeDate: '2026-06-20',
      dueDate: '2026-07-05',
    });
  });

  it('keeps due date in the same month when dueDay > closingDay', () => {
    expect(billPeriodForCycle(6, 2026, 5, 15)).toEqual({
      month: 6,
      year: 2026,
      closeDate: '2026-06-05',
      dueDate: '2026-06-15',
    });
  });

  it('rolls the due date into January for a December cycle', () => {
    expect(billPeriodForCycle(12, 2026, 20, 5)).toEqual({
      month: 12,
      year: 2026,
      closeDate: '2026-12-20',
      dueDate: '2027-01-05',
    });
  });
});

describe('resolveBillPeriod', () => {
  it('derives the cycle from the date when no explicit billMonth/billYear is given', () => {
    expect(resolveBillPeriod(undefined, undefined, '2026-06-15', 20, 5)).toEqual(billPeriodFor('2026-06-15', 20, 5));
  });

  it('uses the explicit cycle override when both billMonth and billYear are given', () => {
    expect(resolveBillPeriod(8, 2026, '2026-06-15', 20, 5)).toEqual(billPeriodForCycle(8, 2026, 20, 5));
  });
});

const bill: Bill = {
  id: 'bill-1',
  month: 6,
  year: 2026,
  closeDate: '2026-06-28',
  dueDate: '2026-07-05',
  status: BillStatus.enum.open,
};

describe('isBillPaid', () => {
  it('is false for open/closed bills', () => {
    expect(isBillPaid(bill)).toBe(false);
    expect(isBillPaid({ ...bill, status: BillStatus.enum.closed })).toBe(false);
  });

  it('is true for paid bills', () => {
    expect(isBillPaid({ ...bill, status: BillStatus.enum.paid })).toBe(true);
  });
});

describe('withStatusLabel', () => {
  it('adds statusLabel for the given locale (data-first)', () => {
    expect(withStatusLabel(bill, Locale.enum.pt).statusLabel).toBe('Aberta');
  });

  it('works as data-last for pipes', () => {
    expect(withStatusLabel(Locale.enum.es)(bill).statusLabel).toBe('Abierta');
  });

  it('preserves original status value', () => {
    expect(withStatusLabel(bill, Locale.enum.pt).status).toBe(BillStatus.enum.open);
  });

  it('labels paid status', () => {
    const paid: Bill = { ...bill, status: BillStatus.enum.paid };
    expect(withStatusLabel(paid, Locale.enum.en).statusLabel).toBe('Paid');
  });
});

describe('assertBillPeriodPaired', () => {
  it('passes when neither billMonth nor billYear is provided', () => {
    expect(assertBillPeriodPaired({})).toBe(true);
  });

  it('passes when both are provided', () => {
    expect(assertBillPeriodPaired({ billMonth: 6, billYear: 2026 })).toBe(true);
  });

  it('fails when only billMonth is provided', () => {
    expect(assertBillPeriodPaired({ billMonth: 6 })).toBe(false);
  });

  it('fails when only billYear is provided', () => {
    expect(assertBillPeriodPaired({ billYear: 2026 })).toBe(false);
  });
});

describe('withBillId', () => {
  it('reports the transaction with its new bill assignment', () => {
    expect(withBillId(tx('expense', 100), 'bill-9').billId).toBe('bill-9');
  });

  it('preserves the rest of the transaction unchanged', () => {
    const original = tx('income', 50);
    const updated = withBillId(original, 'bill-9');
    expect(updated).toMatchObject({ ...original, billId: 'bill-9' });
  });
});

describe('billPeriodKey', () => {
  it('is the month-year identity of the cycle, unpadded', () => {
    expect(billPeriodKey({ month: 3, year: 2026 })).toBe('3-2026');
    expect(billPeriodKey(billPeriodForCycle(12, 2026, 10, 20))).toBe('12-2026');
  });
});

describe('bill payment', () => {
  const facts = (overrides: Partial<Parameters<typeof planBillPayment>[0]> = {}) => ({
    id: 'tx-pay',
    card: { name: 'Nubank', currency: CurrencyCode.enum.BRL, accountId: 'liab-1' },
    payer: { id: 'acc-1' },
    bill: { id: 'bill-1', month: 3, year: 2026 },
    amount: 250.5,
    decimals: 2,
    date: '2026-04-05',
    today: '2026-04-05',
    source: TransactionSource.enum.mcp,
    ...overrides,
  });

  it('describes the payment with the card and a zero-padded MM/YYYY', () => {
    expect(billPaymentDescription('Nubank', 3, 2026)).toBe('Bill payment: Nubank 03/2026');
    expect(billPaymentDescription('Nubank', 11, 2026)).toBe('Bill payment: Nubank 11/2026');
  });

  it('plans a transfer of the chosen amount from the payer to the card account, linked to the bill', () => {
    const { transferEntity } = planBillPayment(facts());
    expect(transferEntity).toEqual({
      id: 'tx-pay',
      description: 'Bill payment: Nubank 03/2026',
      amount: 250.5,
      type: TransactionType.enum.transfer,
      status: TransactionStatus.enum.effective,
      date: '2026-04-05',
      currency: CurrencyCode.enum.BRL,
      source: TransactionSource.enum.mcp,
      classification: { method: ClassificationMethod.enum.none, confidence: 0 },
      refs: { accountId: 'acc-1', toAccountId: 'liab-1', billId: 'bill-1' },
    });
  });

  it('a payment dated before today is effective; the plan takes its currency from the card', () => {
    const plan = planBillPayment(
      facts({ date: '2026-04-01', card: { name: 'Visa', currency: CurrencyCode.enum.USD, accountId: 'liab-2' } }),
    );
    expect(plan.transferEntity).toMatchObject({ status: 'effective', currency: 'USD', date: '2026-04-01' });
  });

  describe('billPaymentKey', () => {
    it('is a sha256 over bill, date, amount and discriminator, not the old billpay-<id> form', () => {
      expect(planBillPayment(facts()).idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is stable for the same payment and amount rounded to the currency decimals', () => {
      expect(billPaymentKey(facts({ amount: 10.004 }))).toBe(billPaymentKey(facts({ amount: 10 })));
    });

    it.each([
      ['another bill', { bill: { id: 'bill-2', month: 3, year: 2026 } }],
      ['another date', { date: '2026-04-04' }],
      ['another amount', { amount: 250.51 }],
      ['a discriminator', { discriminator: 'again' }],
    ])('differs with %s', (_label, overrides) => {
      expect(billPaymentKey(facts(overrides))).not.toBe(billPaymentKey(facts()));
    });
  });
});

describe('bill settlement', () => {
  const transfer = (overrides: Partial<TransactionView>): TransactionView => ({
    ...tx(TransactionType.enum.transfer, 60),
    toAccountId: 'liab-1',
    accountName: 'Checking',
    billId: 'bill-1',
    date: '2026-04-05',
    ...overrides,
  });

  describe('paymentsOf', () => {
    it('lists the transfers into the card account, oldest first, ignoring purchases and other transfers', () => {
      const items = [
        tx(TransactionType.enum.expense, 100),
        transfer({ id: 'late', date: '2026-04-09', amount: 30 }),
        transfer({ id: 'elsewhere', toAccountId: 'other' }),
        transfer({ id: 'early', date: '2026-04-01', amount: 60 }),
      ];
      expect(paymentsOf(items, 'liab-1')).toEqual([
        { id: 'early', date: '2026-04-01', amount: 60, account: 'Checking' },
        { id: 'late', date: '2026-04-09', amount: 30, account: 'Checking' },
      ]);
    });
  });

  describe('settlement', () => {
    const payments = [{ id: 'p1', date: '2026-04-01', amount: 60 }];

    it('derives paid, remaining and partiallyPaid from the total and the payments', () => {
      expect(settlement(100, payments, 2)).toEqual({ paidAmount: 60, remaining: 40, partiallyPaid: true });
    });

    it('is not partially paid without a payment, nor once nothing remains', () => {
      expect(settlement(100, [], 2)).toEqual({ paidAmount: 0, remaining: 100, partiallyPaid: false });
      expect(settlement(60, payments, 2)).toEqual({ paidAmount: 60, remaining: 0, partiallyPaid: false });
    });

    it("rounds to the currency's own decimals, never a flat 2", () => {
      expect(settlement(0.3, [{ id: 'p', date: '2026-04-01', amount: 0.1 }], 8).remaining).toBe(0.2);
      expect(settlement(10.005, [], 2).remaining).toBe(10.01);
    });
  });

  it('toSettledBill reports the latest payment as paymentTransactionId, absent without one', () => {
    const bill = {
      id: 'b',
      month: 4,
      year: 2026,
      closeDate: '2026-04-28',
      dueDate: '2026-05-05',
      status: BillStatus.enum.closed,
    };
    const two = [
      { id: 'p1', date: '2026-04-01', amount: 60 },
      { id: 'p2', date: '2026-04-09', amount: 30 },
    ];
    expect(toSettledBill(bill, two, settlement(100, two, 2))).toMatchObject({
      paymentTransactionId: 'p2',
      payments: two,
    });
    expect(toSettledBill(bill, [], settlement(100, [], 2)).paymentTransactionId).toBeUndefined();
  });

  it.each([
    ['settled with no payment at all', []],
    ['whose transfers add up to less than its total', [{ id: 'p1', date: '2026-04-01', amount: 10 }]],
  ])('a paid bill %s reports remaining 0 and is not partially paid', (_label, payments) => {
    const paid = {
      id: 'b',
      month: 4,
      year: 2026,
      closeDate: '2026-04-28',
      dueDate: '2026-05-05',
      status: BillStatus.enum.paid,
    };

    expect(toSettledBill(paid, payments, settlement(100, payments, 2))).toMatchObject({
      remaining: 0,
      partiallyPaid: false,
      paidAmount: payments.length ? 10 : 0,
    });
  });

  describe('paymentsOnLatestDate', () => {
    it('returns the payments sharing the latest date, none for no payment', () => {
      const payments = [
        { id: 'a', date: '2026-04-01', amount: 1 },
        { id: 'b', date: '2026-04-09', amount: 1 },
        { id: 'c', date: '2026-04-09', amount: 1 },
      ];
      expect(paymentsOnLatestDate(payments).map((p) => p.id)).toEqual(['b', 'c']);
      expect(paymentsOnLatestDate([])).toEqual([]);
    });
  });

  it('hasIdempotencyKey recognizes an already recorded payment', () => {
    const items = [{ ...tx(TransactionType.enum.transfer, 5), idempotencyKey: 'k1' }];
    expect(hasIdempotencyKey(items, 'k1')).toBe(true);
    expect(hasIdempotencyKey(items, 'k2')).toBe(false);
  });

  describe('totalAfterChange and coversPaid', () => {
    const items = [
      { ...tx(TransactionType.enum.expense, 100), id: 'e1' },
      { ...tx(TransactionType.enum.expense, 50), id: 'e2' },
    ];

    it('applies a removal and an addition to the total', () => {
      expect(totalAfterChange(items, { removedId: 'e1' })).toBe(50);
      expect(totalAfterChange(items, { added: { type: TransactionType.enum.income, amount: 20 } })).toBe(130);
      expect(
        totalAfterChange(items, { removedId: 'e2', added: { type: TransactionType.enum.expense, amount: 10 } }),
      ).toBe(110);
    });

    it('a total covers what is paid down to the last unit of the currency', () => {
      expect(coversPaid(100, 100, 2)).toBe(true);
      expect(coversPaid(99.99, 100, 2)).toBe(false);
    });

    it('a bill with nothing paid is never short, even with a credit balance', () => {
      expect(coversPaid(-30, 0, 2)).toBe(true);
    });
  });
});
