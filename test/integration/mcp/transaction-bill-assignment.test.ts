import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, ensure, makeClient, searchTransactions } from './helpers.js';

describe('MCP integration > transaction ↔ bill assignment (Design 012)', () => {
  const now = new Date();
  const stamp = now.getTime();
  // Pin to day 15 so the purchase always falls within the closingDay=28 cycle
  const pinned = new Date(now.getFullYear(), now.getMonth(), 15);
  const today = toIsoDate(pinned);
  const month = pinned.getMonth() + 1;
  const year = pinned.getFullYear();
  const nextCycle = month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(pinned);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('assigns a card transaction to an explicit bill cycle, auto-creating the target bill', async () => {
    const cardName = `Assign Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Assign purchase ${stamp}`,
          amount: 60,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: nextCycle.month,
          billYear: nextCycle.year,
          idempotencyKey: `assign-purchase-${stamp}`,
        },
      })) as { transaction?: { billId?: string } };
      ensure(created.transaction?.billId, 'expected the transaction to be attached to a bill');

      // The default (auto-assigned) cycle bill was never touched/created.
      const defaultCycleErr = (await callToolError(client, {
        name: 'get_bill',
        args: { card: cardName, month, year },
      })) as { error?: { code?: string } };
      expect(defaultCycleErr.error?.code).toBe('unknown_bill');

      // The explicit target cycle bill was auto-created and holds the purchase.
      const targetBill = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month: nextCycle.month, year: nextCycle.year },
      })) as { bill?: { id?: string }; total?: number };
      expect(targetBill.bill?.id).toBe(created.transaction.billId);
      expect(targetBill.total).toBe(60);
    } finally {
      await transport.close();
    }
  });

  it('rejects billMonth without billYear (and vice versa) on create and update', async () => {
    const cardName = `Pairing Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const err = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: `Pairing purchase ${stamp}`,
          amount: 10,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: nextCycle.month,
          idempotencyKey: `pairing-purchase-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Pairing purchase ok ${stamp}`,
          amount: 10,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `pairing-purchase-ok-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(created.transaction?.id, 'expected a created transaction');

      const updateErr = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: created.transaction.id, billYear: nextCycle.year },
      })) as { error?: { code?: string } };
      expect(updateErr.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('rejects bill assignment on a non-card (account) transaction at create and update', async () => {
    const bankName = `NonCard Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 100 },
      });

      const err = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: `NonCard expense ${stamp}`,
          amount: 10,
          type: 'expense',
          date: today,
          account: bankName,
          billMonth: month,
          billYear: year,
          idempotencyKey: `noncard-expense-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(err.error?.code).toBe('validation');

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `NonCard expense ok ${stamp}`,
          amount: 10,
          type: 'expense',
          date: today,
          account: bankName,
          idempotencyKey: `noncard-expense-ok-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(created.transaction?.id, 'expected a created transaction');

      const updateErr = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: created.transaction.id, billMonth: month, billYear: year },
      })) as { error?: { code?: string } };
      expect(updateErr.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('reassigns a transaction via update_transaction, updating both bills correctly', async () => {
    const cardName = `Reassign Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Reassign purchase ${stamp}`,
          amount: 75,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `reassign-purchase-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(created.transaction?.id, 'expected a created transaction');

      const beforeOld = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month, year },
      })) as { total?: number };
      expect(beforeOld.total).toBe(75);

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: created.transaction.id, billMonth: nextCycle.month, billYear: nextCycle.year },
      })) as { billId?: string };
      ensure(updated.billId, 'expected the reassigned transaction to report a billId');

      const afterOld = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month, year },
      })) as { total?: number };
      expect(afterOld.total).toBe(0);

      const afterNew = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month: nextCycle.month, year: nextCycle.year },
      })) as { bill?: { id?: string }; total?: number };
      expect(afterNew.bill?.id).toBe(updated.billId);
      expect(afterNew.total).toBe(75);
    } finally {
      await transport.close();
    }
  });

  it('rejects create landing on a paid bill, both by explicit selector and by plain auto-assignment', async () => {
    const cardName = `PaidGuard Card ${stamp}`;
    const bankName = `PaidGuard Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      });
      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `PaidGuard purchase ${stamp}`,
          amount: 40,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `paidguard-purchase-${stamp}`,
        },
      });
      await callTool(client, { name: 'pay_bill', args: { card: cardName, month, year } });

      const explicitErr = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: `PaidGuard late purchase explicit ${stamp}`,
          amount: 15,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: month,
          billYear: year,
          idempotencyKey: `paidguard-late-explicit-${stamp}`,
        },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(explicitErr.error?.code).toBe('validation');
      expect(explicitErr.error?.issues?.[0]).toContain('revert_bill_payment');

      // Same rejection via plain cycle auto-assignment (no explicit billMonth/billYear) — a
      // transaction dated inside the now-paid cycle must not silently attach either.
      const autoErr = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: `PaidGuard late purchase auto ${stamp}`,
          amount: 15,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `paidguard-late-auto-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(autoErr.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('rejects update_transaction moving a transaction onto a paid bill', async () => {
    const cardName = `OntoPaid Card ${stamp}`;
    const bankName = `OntoPaid Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      });
      await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `OntoPaid paid-cycle purchase ${stamp}`,
          amount: 30,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `ontopaid-paid-purchase-${stamp}`,
        },
      });
      await callTool(client, { name: 'pay_bill', args: { card: cardName, month, year } });

      const openPurchase = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `OntoPaid open-cycle purchase ${stamp}`,
          amount: 20,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: nextCycle.month,
          billYear: nextCycle.year,
          idempotencyKey: `ontopaid-open-purchase-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(openPurchase.transaction?.id, 'expected a created transaction');

      const err = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: openPurchase.transaction.id, billMonth: month, billYear: year },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(err.error?.code).toBe('validation');
      expect(err.error?.issues?.[0]).toContain('revert_bill_payment');
    } finally {
      await transport.close();
    }
  });

  it('rejects moving a transaction off a paid bill, and rejects deleting it — both hint at revert', async () => {
    const cardName = `OffPaid Card ${stamp}`;
    const bankName = `OffPaid Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      });
      const purchase = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `OffPaid purchase ${stamp}`,
          amount: 50,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `offpaid-purchase-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(purchase.transaction?.id, 'expected a created transaction');

      await callTool(client, { name: 'pay_bill', args: { card: cardName, month, year } });

      // Move off the now-paid bill — rejected.
      const moveErr = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: purchase.transaction.id, billMonth: nextCycle.month, billYear: nextCycle.year },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(moveErr.error?.code).toBe('validation');
      expect(moveErr.error?.issues?.[0]).toContain('revert_bill_payment');

      // Delete the (ordinary, non-payment-transfer) purchase — also rejected.
      const deleteErr = (await callToolError(client, {
        name: 'delete_transaction',
        args: { id: purchase.transaction.id, confirm: true },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(deleteErr.error?.code).toBe('validation');
      expect(deleteErr.error?.issues?.[0]).toContain('revert_bill_payment');

      // It's still there, undeleted.
      const stillThere = (await searchTransactions(client, {
        text: `OffPaid purchase ${stamp}`,
        limit: 10,
      })) as Array<{ id?: string }>;
      expect(stillThere.some((tx) => tx.id === purchase.transaction.id)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('full flow: revert_bill_payment unblocks reassignment, then pay_bill on the new cycle succeeds', async () => {
    const cardName = `FullFlow Card ${stamp}`;
    const bankName = `FullFlow Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL', paymentAccount: bankName },
      });
      const purchase = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `FullFlow purchase ${stamp}`,
          amount: 90,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `fullflow-purchase-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(purchase.transaction?.id, 'expected a created transaction');

      await callTool(client, { name: 'pay_bill', args: { card: cardName, month, year } });

      // Blocked before revert.
      const blocked = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: purchase.transaction.id, billMonth: nextCycle.month, billYear: nextCycle.year },
      })) as { error?: { code?: string } };
      expect(blocked.error?.code).toBe('validation');

      const reverted = (await callTool(client, {
        name: 'revert_bill_payment',
        args: { card: cardName, month, year },
      })) as { status?: string };
      expect(reverted.status).toBe('closed');

      // Now the reassignment succeeds.
      const reassigned = (await callTool(client, {
        name: 'update_transaction',
        args: { id: purchase.transaction.id, billMonth: nextCycle.month, billYear: nextCycle.year },
      })) as { billId?: string };
      ensure(reassigned.billId, 'expected the reassigned transaction to report a billId');

      // And paying the new cycle's bill succeeds.
      const paid = (await callTool(client, {
        name: 'pay_bill',
        args: { card: cardName, month: nextCycle.month, year: nextCycle.year },
      })) as { status?: string };
      expect(paid.status).toBe('paid');
    } finally {
      await transport.close();
    }
  });
});
