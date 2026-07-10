import { describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, ensure, makeClient } from './helpers.js';

describe('MCP integration > add_card_purchase (ADR-016 step 2)', () => {
  const now = new Date();
  const stamp = now.getTime();
  // Pin to day 15 so the purchase always falls within the closingDay=28 cycle.
  const pinned = new Date(now.getFullYear(), now.getMonth(), 15);
  const today = toIsoDate(pinned);
  const month = pinned.getMonth() + 1;
  const year = pinned.getFullYear();
  const nextCycle = month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };

  it('joins the default cycle bill (auto-assignment)', async () => {
    const cardName = `AddPurchase Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const created = (await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Add purchase ${stamp}`,
          amount: 30,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `add-card-purchase-${stamp}`,
        },
      })) as { transaction?: { billId?: string } };
      ensure(created.transaction?.billId, 'expected the purchase to be attached to a bill');

      const bill = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month, year },
      })) as { bill?: { id?: string }; total?: number };
      expect(bill.bill?.id).toBe(created.transaction.billId);
      expect(bill.total).toBe(30);
    } finally {
      await transport.close();
    }
  });

  it('joins an explicit target cycle, auto-creating the bill', async () => {
    const cardName = `AddPurchase Explicit Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const created = (await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Add purchase explicit ${stamp}`,
          amount: 55,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: nextCycle.month,
          billYear: nextCycle.year,
          idempotencyKey: `add-card-purchase-explicit-${stamp}`,
        },
      })) as { transaction?: { billId?: string } };
      ensure(created.transaction?.billId, 'expected the purchase to be attached to a bill');

      const targetBill = (await callTool(client, {
        name: 'get_bill',
        args: { card: cardName, month: nextCycle.month, year: nextCycle.year },
      })) as { bill?: { id?: string }; total?: number };
      expect(targetBill.bill?.id).toBe(created.transaction.billId);
      expect(targetBill.total).toBe(55);
    } finally {
      await transport.close();
    }
  });

  it('rejects landing on an already-paid bill, both by explicit selector and plain auto-assignment', async () => {
    const cardName = `AddPurchase PaidGuard Card ${stamp}`;
    const bankName = `AddPurchase PaidGuard Bank ${stamp}`;
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
        name: 'add_card_purchase',
        args: {
          description: `AddPurchase PaidGuard purchase ${stamp}`,
          amount: 40,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `add-card-purchase-paidguard-${stamp}`,
        },
      });
      await callTool(client, { name: 'pay_bill', args: { card: cardName, month, year } });

      const explicitErr = (await callToolError(client, {
        name: 'add_card_purchase',
        args: {
          description: `AddPurchase PaidGuard late explicit ${stamp}`,
          amount: 15,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: month,
          billYear: year,
          idempotencyKey: `add-card-purchase-paidguard-late-explicit-${stamp}`,
        },
      })) as { error?: { code?: string; issues?: string[] } };
      expect(explicitErr.error?.code).toBe('validation');
      expect(explicitErr.error?.issues?.[0]).toContain('revert_bill_payment');

      const autoErr = (await callToolError(client, {
        name: 'add_card_purchase',
        args: {
          description: `AddPurchase PaidGuard late auto ${stamp}`,
          amount: 15,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `add-card-purchase-paidguard-late-auto-${stamp}`,
        },
      })) as { error?: { code?: string } };
      expect(autoErr.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('is idempotent — same idempotencyKey returns the existing purchase', async () => {
    const cardName = `AddPurchase Idempotent Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const args = {
        description: `AddPurchase idempotent ${stamp}`,
        amount: 22,
        type: 'expense',
        date: today,
        card: cardName,
        idempotencyKey: `add-card-purchase-idempotent-${stamp}`,
      };

      const first = (await callTool(client, { name: 'add_card_purchase', args })) as {
        created?: boolean;
        transaction?: { id?: string };
      };
      expect(first.created).toBe(true);

      const replay = (await callTool(client, { name: 'add_card_purchase', args })) as {
        created?: boolean;
        transaction?: { id?: string };
      };
      expect(replay.created).toBe(false);
      expect(replay.transaction?.id).toBe(first.transaction?.id);
    } finally {
      await transport.close();
    }
  });

  it('produces the same shape as create_transaction with card (routing parity)', async () => {
    const cardName = `AddPurchase Parity Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const viaLegacyTool = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `Parity via create_transaction ${stamp}`,
          amount: 12,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `parity-legacy-${stamp}`,
        },
      })) as { transaction?: { billId?: string; cardId?: string; currency?: string } };

      const viaNewTool = (await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Parity via add_card_purchase ${stamp}`,
          amount: 12,
          type: 'expense',
          date: today,
          card: cardName,
          idempotencyKey: `parity-new-${stamp}`,
        },
      })) as { transaction?: { billId?: string; cardId?: string; currency?: string } };

      ensure(viaLegacyTool.transaction?.billId, 'expected create_transaction (card) to attach a bill');
      ensure(viaNewTool.transaction?.billId, 'expected add_card_purchase to attach a bill');
      expect(viaNewTool.transaction?.billId).toBe(viaLegacyTool.transaction?.billId);
      expect(viaNewTool.transaction?.cardId).toBe(viaLegacyTool.transaction?.cardId);
      expect(viaNewTool.transaction?.currency).toBe(viaLegacyTool.transaction?.currency);
    } finally {
      await transport.close();
    }
  });

  it('create_transactions_bulk routes a card line to add_card_purchase, attaching its bill', async () => {
    const cardName = `AddPurchase Bulk Card ${stamp}`;
    const bankName = `AddPurchase Bulk Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const result = (await callTool(client, {
        name: 'create_transactions_bulk',
        args: {
          items: [
            {
              description: `Bulk account line ${stamp}`,
              amount: 10,
              type: 'expense',
              date: today,
              account: bankName,
              idempotencyKey: `bulk-account-${stamp}`,
            },
            {
              description: `Bulk card line ${stamp}`,
              amount: 20,
              type: 'expense',
              date: today,
              card: cardName,
              idempotencyKey: `bulk-card-${stamp}`,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; transaction?: { billId?: string; cardId?: string } }> };

      ensure(result.items?.length === 2, 'expected two bulk item results');
      const [accountItem, cardItem] = result.items;
      expect(accountItem?.status).not.toBe('error');
      expect(accountItem?.transaction?.billId).toBeUndefined();
      expect(cardItem?.status).not.toBe('error');
      ensure(cardItem?.transaction?.billId, 'expected the bulk card line to be attached to a bill');
    } finally {
      await transport.close();
    }
  });

  it('create_transactions_bulk rejects a line resolving both account and card via top-level defaults', async () => {
    const cardName = `AddPurchase Bulk Exclusive Card ${stamp}`;
    const bankName = `AddPurchase Bulk Exclusive Bank ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: bankName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });
      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      // Top-level account default + an item-level card override — resolves both account and card
      // for that item, which must be rejected the same way create_transaction rejects it directly.
      const result = (await callTool(client, {
        name: 'create_transactions_bulk',
        args: {
          account: bankName,
          items: [
            {
              description: `Bulk exclusive line ${stamp}`,
              amount: 10,
              type: 'expense',
              date: today,
              card: cardName,
              idempotencyKey: `bulk-exclusive-${stamp}`,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; error?: string }> };

      ensure(result.items?.length === 1, 'expected one bulk item result');
      expect(result.items[0]?.status).toBe('error');
      expect(result.items[0]?.error).toContain('validation');
    } finally {
      await transport.close();
    }
  });
});
