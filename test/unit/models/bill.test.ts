import { describe, expect, it } from 'vitest';
import {
  BillQuerySchema,
  BillSchema,
  PayBillSchema,
  RevertBillPaymentSchema,
  SettledBillSchema,
} from '../../../src/models/bill.js';
import {
  BillQuery as WireBillQuery,
  PayBill as WirePayBill,
  RevertBillPayment as WireRevertBillPayment,
} from '../../../src/wire/in/bills.js';

describe('BillSchema', () => {
  it('parses a valid bill', () => {
    const result = BillSchema.safeParse({
      id: 'b1',
      month: 6,
      year: 2025,
      closeDate: '2025-06-28',
      dueDate: '2025-07-05',
      status: 'open',
    });
    expect(result.success).toBe(true);
  });

  it('rejects month outside 1–12', () => {
    expect(
      BillSchema.safeParse({
        id: 'b1',
        month: 0,
        year: 2025,
        closeDate: '2025-06-28',
        dueDate: '2025-07-05',
        status: 'open',
      }).success,
    ).toBe(false);
    expect(
      BillSchema.safeParse({
        id: 'b1',
        month: 13,
        year: 2025,
        closeDate: '2025-06-28',
        dueDate: '2025-07-05',
        status: 'open',
      }).success,
    ).toBe(false);
  });

  it('rejects year outside 2000–2100', () => {
    expect(
      BillSchema.safeParse({
        id: 'b1',
        month: 1,
        year: 1999,
        closeDate: '2025-01-28',
        dueDate: '2025-02-05',
        status: 'open',
      }).success,
    ).toBe(false);
    expect(
      BillSchema.safeParse({
        id: 'b1',
        month: 1,
        year: 2101,
        closeDate: '2025-01-28',
        dueDate: '2025-02-05',
        status: 'open',
      }).success,
    ).toBe(false);
  });
});

describe('BillQuerySchema (model — strict typed numbers)', () => {
  it('accepts valid query', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 6, year: 2025 }).success).toBe(true);
  });

  it('rejects string month (no coercion at model layer)', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: '6', year: 2025 }).success).toBe(false);
  });

  it('rejects out-of-range month', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 0, year: 2025 }).success).toBe(false);
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 13, year: 2025 }).success).toBe(false);
  });

  it('rejects out-of-range year', () => {
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 6, year: 1999 }).success).toBe(false);
    expect(BillQuerySchema.safeParse({ card: 'Nubank', month: 6, year: 2101 }).success).toBe(false);
  });

  it('rejects empty card', () => {
    expect(BillQuerySchema.safeParse({ card: '', month: 6, year: 2025 }).success).toBe(false);
  });
});

describe('PayBillSchema (model — extends BillQuerySchema)', () => {
  it('accepts without account', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025 }).success).toBe(true);
  });

  it('accepts with account', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025, account: 'Itaú' }).success).toBe(true);
  });

  it('rejects empty account string', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025, account: '' }).success).toBe(false);
  });

  it('accepts with paymentDate', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025, paymentDate: '2025-06-15' }).success).toBe(
      true,
    );
  });

  it('rejects a malformed paymentDate', () => {
    expect(PayBillSchema.safeParse({ card: 'Nubank', month: 6, year: 2025, paymentDate: '06/15/2025' }).success).toBe(
      false,
    );
  });
});

describe('PayBillSchema — partial payment inputs', () => {
  const base = { card: 'Nubank', month: 6, year: 2025 };

  it('accepts a positive amount and a discriminator', () => {
    expect(PayBillSchema.safeParse({ ...base, amount: 40.5, discriminator: 'second' }).success).toBe(true);
  });

  it.each([0, -5])('rejects an amount of %s', (amount) => {
    expect(PayBillSchema.safeParse({ ...base, amount }).success).toBe(false);
  });

  it('rejects an empty discriminator', () => {
    expect(PayBillSchema.safeParse({ ...base, discriminator: '' }).success).toBe(false);
  });

  it('is carried through the wire schema unchanged', () => {
    const result = WirePayBill.safeParse({ ...base, month: '6', year: '2025', amount: 40, discriminator: 'x' });
    expect(result.success && result.data).toMatchObject({ amount: 40, discriminator: 'x' });
  });
});

describe('RevertBillPaymentSchema', () => {
  const base = { card: 'Nubank', month: 6, year: 2025 };

  it('takes an optional paymentId, in the model and on the wire', () => {
    expect(RevertBillPaymentSchema.safeParse(base).success).toBe(true);
    expect(RevertBillPaymentSchema.safeParse({ ...base, paymentId: 'tx-1' }).success).toBe(true);
    expect(WireRevertBillPayment.safeParse({ ...base, paymentId: 'tx-1' }).success).toBe(true);
  });

  it('rejects an empty paymentId', () => {
    expect(RevertBillPaymentSchema.safeParse({ ...base, paymentId: '' }).success).toBe(false);
  });
});

describe('SettledBillSchema', () => {
  const bill = { id: 'b1', month: 6, year: 2025, closeDate: '2025-06-28', dueDate: '2025-07-05', status: 'closed' };

  it('adds what is paid, what remains and the payments to the stored bill', () => {
    const result = SettledBillSchema.safeParse({
      ...bill,
      paidAmount: 60,
      remaining: 40,
      partiallyPaid: true,
      payments: [{ id: 'tx-1', date: '2025-06-10', amount: 60, account: 'Checking' }],
      paymentTransactionId: 'tx-1',
    });
    expect(result.success).toBe(true);
  });

  it('requires the settlement fields', () => {
    expect(SettledBillSchema.safeParse(bill).success).toBe(false);
  });
});

describe('Wire BillQuery (REST boundary — coerces strings)', () => {
  it('coerces string month/year from query params', () => {
    const result = WireBillQuery.safeParse({ card: 'Nubank', month: '6', year: '2025' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.month).toBe(6);
      expect(result.data.year).toBe(2025);
    }
  });

  it('still accepts typed numbers', () => {
    expect(WireBillQuery.safeParse({ card: 'Nubank', month: 6, year: 2025 }).success).toBe(true);
  });

  it('rejects out-of-range after coercion', () => {
    expect(WireBillQuery.safeParse({ card: 'Nubank', month: '13', year: '2025' }).success).toBe(false);
    expect(WireBillQuery.safeParse({ card: 'Nubank', month: '6', year: '1999' }).success).toBe(false);
  });
});

describe('Wire PayBill (REST boundary — coerces strings)', () => {
  it('coerces month/year and keeps optional account', () => {
    const result = WirePayBill.safeParse({ card: 'Nubank', month: '6', year: '2025', account: 'Itaú' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.month).toBe(6);
      expect(result.data.account).toBe('Itaú');
    }
  });

  it('accepts a valid ISO paymentDate', () => {
    const result = WirePayBill.safeParse({ card: 'Nubank', month: '6', year: '2025', paymentDate: '2025-06-15' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paymentDate).toBe('2025-06-15');
    }
  });

  it('rejects a malformed paymentDate', () => {
    const result = WirePayBill.safeParse({ card: 'Nubank', month: '6', year: '2025', paymentDate: '06/15/2025' });
    expect(result.success).toBe(false);
  });
});
