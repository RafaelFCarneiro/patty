import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, ensure, makeClient, searchTransactions } from './helpers.js';

describe('MCP integration > bill payment (Design 003)', () => {
  const now = new Date();
  const stamp = now.getTime();
  const cardName = `BillPay Card ${stamp}`;
  const bankName = `BillPay Bank ${stamp}`;
  // Pin to day 15 so the purchase always falls within the closingDay=28 cycle
  const pinned = new Date(now.getFullYear(), now.getMonth(), 15);
  const today = toIsoDate(pinned);
  const month = pinned.getMonth() + 1;
  const year = pinned.getFullYear();

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(pinned);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('pay_bill creates a transfer, debits payer, credits card account, marks bill paid', async () => {
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 5000 },
      });

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      });

      // Make a purchase
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `BillPay purchase ${stamp}`,
          amount: 300,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `billpay-purchase-${stamp}`,
        },
      });

      // Capture expenses before payment to prove the transfer doesn't inflate them
      const preSummary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as { currencies?: Array<{ currency?: string; expenses?: number }> };
      const preExpenses = preSummary.currencies?.find((s) => s.currency === 'BRL')?.expenses ?? 0;

      // Pay the bill
      const paidBill = (await callTool(client, {
        name: 'pay_bill',
        args: { card: cardName, month, year },
      })) as { status?: string };
      expect(paidBill.status).toBe('paid');

      // Payer balance should be reduced
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: {},
      })) as Array<{ name?: string; balance?: number }>;

      const bank = balances.find((b) => b.name === bankName);
      expect(bank?.balance).toBe(4700); // 5000 - 300

      // Card account balance should be 0 (debt paid off)
      const cardAccount = balances.find((b) => b.name === `Card: ${cardName}`);
      expect(cardAccount?.balance).toBe(0); // -300 + 300 transfer in

      // Expenses unchanged after pay_bill — transfer is not counted as expense
      const postSummary = (await callTool(client, {
        name: 'get_spending_summary',
        args: { month, year },
      })) as { currencies?: Array<{ currency?: string; expenses?: number }> };
      const postExpenses = postSummary.currencies?.find((s) => s.currency === 'BRL')?.expenses ?? 0;
      expect(postExpenses).toBe(preExpenses);

      // Idempotency: re-calling pay_bill on a paid bill is a no-op
      const idempotent = (await callTool(client, {
        name: 'pay_bill',
        args: { card: cardName, month, year },
      })) as { status?: string };
      expect(idempotent.status).toBe('paid');
    } finally {
      await transport.close();
    }
  });

  it('pay_bill without account and without card default returns validation error', async () => {
    const noDefaultCard = `NoDefault Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: noDefaultCard, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `NoDefault purchase ${stamp}`,
          amount: 50,
          type: 'expense',
          date: today,
          card: noDefaultCard,
          idempotencyKey: `nodefault-purchase-${stamp}`,
        },
      });

      const err = (await callToolError(client, {
        name: 'pay_bill',
        args: { card: noDefaultCard, month, year },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('pay_bill with currency mismatch returns validation error', async () => {
    const usdCard = `USD Card ${stamp}`;
    const brlBank = `Mismatch Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: brlBank, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: usdCard, closingDay: 28, dueDay: 5, currency: 'USD' },
      });

      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `USD purchase ${stamp}`,
          amount: 25,
          type: 'expense',
          date: today,
          card: usdCard,
          idempotencyKey: `usd-purchase-${stamp}`,
        },
      });

      // Try to pay with a BRL account
      const err = (await callToolError(client, {
        name: 'pay_bill',
        args: { card: usdCard, month, year, account: brlBank },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('note is returned on get_bill transaction rows', async () => {
    const noteCardName = `Note Bill Card ${stamp}`;
    const noteBankName = `Note Bill Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: noteBankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: noteCardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Note bill tx ${stamp}`,
          amount: 42,
          type: 'expense',
          date: today,
          card: noteCardName,
          idempotencyKey: `note-bill-${stamp}`,
          note: 'warranty until 2027',
        },
      });

      const bill = (await callTool(client, {
        name: 'get_bill',
        args: { card: noteCardName, month, year },
      })) as { transactions?: Array<{ note?: string }> };

      expect(bill.transactions?.length).toBeGreaterThanOrEqual(1);
      expect(bill.transactions?.some((tx) => tx.note === 'warranty until 2027')).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('delete_credit_card dry run returns counts, confirm deletes everything', async () => {
    const delCard = `Del Card ${stamp}`;
    const delBank = `Del Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: delBank, type: 'checking', currency: 'BRL', initialBalance: 2000 },
      });

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: delCard, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: delBank },
      });

      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Del purchase ${stamp}`,
          amount: 100,
          type: 'expense',
          date: today,
          card: delCard,
          idempotencyKey: `del-purchase-${stamp}`,
        },
      });

      // Pay the bill (creates a transfer)
      await callTool(client, {
        name: 'pay_bill',
        args: { card: delCard, month, year },
      });

      // Dry run
      const dryRun = (await callTool(client, {
        name: 'delete_credit_card',
        args: { card: delCard },
      })) as { deleted?: boolean; dryRun?: boolean; wouldDelete?: { transactions?: number; bills?: number } };
      expect(dryRun.deleted).toBe(false);
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.wouldDelete?.transactions).toBeGreaterThanOrEqual(2); // purchase + payment
      expect(dryRun.wouldDelete?.bills).toBeGreaterThanOrEqual(1);

      // Confirm delete
      const deleted = (await callTool(client, {
        name: 'delete_credit_card',
        args: { card: delCard, confirm: true },
      })) as { deleted?: boolean; card?: string };
      expect(deleted.deleted).toBe(true);
      expect(deleted.card).toBe(delCard);

      // Card should be gone
      const err = (await callToolError(client, {
        name: 'delete_credit_card',
        args: { card: delCard },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('unknown_card');

      // Bank account balance should be restored (payment transfer removed)
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: delBank },
      })) as Array<{ balance?: number }>;
      expect(balances[0]?.balance).toBe(2000); // back to initial
    } finally {
      await transport.close();
    }
  });

  it('get_bill returns the correct total across multiple transactions', async () => {
    const multiCardName = `Multi Bill Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: multiCardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Multi purchase A ${stamp}`,
          amount: 120,
          type: 'expense',
          date: today,
          card: multiCardName,
          idempotencyKey: `multi-a-${stamp}`,
        },
      });
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Multi purchase B ${stamp}`,
          amount: 80,
          type: 'expense',
          date: today,
          card: multiCardName,
          idempotencyKey: `multi-b-${stamp}`,
        },
      });
      // A refund/credit on the card reduces the total.
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Multi refund ${stamp}`,
          amount: 20,
          type: 'income',
          date: today,
          card: multiCardName,
          idempotencyKey: `multi-refund-${stamp}`,
        },
      });

      const bill = (await callTool(client, {
        name: 'get_bill',
        args: { card: multiCardName, month, year },
      })) as { total?: number };
      expect(bill.total).toBe(180); // 120 + 80 - 20
    } finally {
      await transport.close();
    }
  });

  it('revert_bill_payment undoes a payment: bill closes, transfer is gone, balances restored', async () => {
    const revertCardName = `Revert Card ${stamp}`;
    const revertBankName = `Revert Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: revertBankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: revertCardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: revertBankName },
      });
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Revert purchase ${stamp}`,
          amount: 200,
          type: 'expense',
          date: today,
          card: revertCardName,
          idempotencyKey: `revert-purchase-${stamp}`,
        },
      });

      const paid = (await callTool(client, {
        name: 'pay_bill',
        args: { card: revertCardName, month, year },
      })) as { status?: string; paymentTransactionId?: string };
      expect(paid.status).toBe('paid');
      expect(paid.paymentTransactionId).toBeTruthy();

      const reverted = (await callTool(client, {
        name: 'revert_bill_payment',
        args: { card: revertCardName, month, year },
      })) as { status?: string; paymentTransactionId?: string };
      expect(reverted.status).toBe('closed');
      expect(reverted.paymentTransactionId).toBeFalsy();

      // The transfer no longer exists.
      const afterRevert = (await searchTransactions(client, {
        text: `Bill payment: ${revertCardName}`,
        limit: 10,
      })) as Array<{ id?: string }>;
      expect(afterRevert.length).toBe(0);

      // Balances restored to pre-pay values.
      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: revertBankName },
      })) as Array<{ balance?: number }>;
      expect(balances[0]?.balance).toBe(1000);
      const cardBalances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: `Card: ${revertCardName}` },
      })) as Array<{ balance?: number }>;
      expect(cardBalances[0]?.balance).toBe(-200);

      // Paying again after a revert succeeds (idempotency key was freed by the delete).
      const paidAgain = (await callTool(client, {
        name: 'pay_bill',
        args: { card: revertCardName, month, year },
      })) as { status?: string };
      expect(paidAgain.status).toBe('paid');
    } finally {
      await transport.close();
    }
  });

  it('revert_bill_payment on a paid bill with no transfer (non-positive total) flips it back, no error', async () => {
    const creditBillCardName = `Credit Bill Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: creditBillCardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });
      // An income (refund/credit) on the card with no offsetting expense makes the bill total <= 0,
      // so pay_bill marks it paid with no transfer (Design 003's non-positive-total branch).
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Credit bill refund ${stamp}`,
          amount: 30,
          type: 'income',
          date: today,
          card: creditBillCardName,
          idempotencyKey: `credit-bill-refund-${stamp}`,
        },
      });

      const paid = (await callTool(client, {
        name: 'pay_bill',
        args: { card: creditBillCardName, month, year },
      })) as { status?: string; paymentTransactionId?: string };
      expect(paid.status).toBe('paid');
      expect(paid.paymentTransactionId).toBeFalsy();

      const reverted = (await callTool(client, {
        name: 'revert_bill_payment',
        args: { card: creditBillCardName, month, year },
      })) as { status?: string; paymentTransactionId?: string };
      expect(reverted.status).toBe('closed');
      expect(reverted.paymentTransactionId).toBeFalsy();
    } finally {
      await transport.close();
    }
  });

  it('revert_bill_payment on a bill that was never paid is a no-op success', async () => {
    const noopCardName = `Noop Revert Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: noopCardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Noop purchase ${stamp}`,
          amount: 30,
          type: 'expense',
          date: today,
          card: noopCardName,
          idempotencyKey: `noop-purchase-${stamp}`,
        },
      });

      const reverted = (await callTool(client, {
        name: 'revert_bill_payment',
        args: { card: noopCardName, month, year },
      })) as { status?: string };
      expect(reverted.status).toBe('open');
    } finally {
      await transport.close();
    }
  });

  it('delete_transaction rejects a bill payment transfer, hinting at revert_bill_payment', async () => {
    const protectedCardName = `Protected Card ${stamp}`;
    const protectedBankName = `Protected Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: protectedBankName, type: 'checking', currency: 'BRL', initialBalance: 500 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: {
          name: protectedCardName,
          closingDay: 28,
          dueDay: 5,
          currency: 'BRL',
          paymentAccount: protectedBankName,
        },
      });
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Protected purchase ${stamp}`,
          amount: 50,
          type: 'expense',
          date: today,
          card: protectedCardName,
          idempotencyKey: `protected-purchase-${stamp}`,
        },
      });
      await callTool(client, { name: 'pay_bill', args: { card: protectedCardName, month, year } });

      const bill = (await callTool(client, {
        name: 'get_bill',
        args: { card: protectedCardName, month, year },
      })) as { bill?: { paymentTransactionId?: string } };
      const paymentTransactionId = bill.bill?.paymentTransactionId;
      ensure(paymentTransactionId, 'expected a linked payment transaction');

      const err = (await callToolError(client, {
        name: 'delete_transaction',
        args: { id: paymentTransactionId, confirm: true },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(err.error?.code).toBe('validation');
      expect(err.error?.issues?.[0]).toContain('revert_bill_payment');

      // It's still there, undeleted.
      const stillThere = (await searchTransactions(client, {
        text: `Bill payment: ${protectedCardName}`,
        limit: 10,
      })) as Array<{ id?: string }>;
      expect(stillThere.some((tx) => tx.id === paymentTransactionId)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('delete_transaction still deletes an ordinary (non-bill) transfer', async () => {
    const fromAcc = `Ordinary From ${stamp}`;
    const toAcc = `Ordinary To ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: fromAcc, type: 'checking', currency: 'BRL', initialBalance: 500 },
      });
      await callTool(client, {
        name: 'create_account',
        args: { name: toAcc, type: 'savings', currency: 'BRL', initialBalance: 0 },
      });

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: { from: fromAcc, to: toAcc, amount: 100, idempotencyKey: `ordinary-transfer-${stamp}` },
      })) as { transaction?: { id?: string } };
      ensure(transfer.transaction?.id, 'expected a created transfer');

      const deleted = (await callTool(client, {
        name: 'delete_transaction',
        args: { id: transfer.transaction.id, confirm: true },
      })) as { deleted?: boolean };
      expect(deleted.deleted).toBe(true);
    } finally {
      await transport.close();
    }
  });
});
