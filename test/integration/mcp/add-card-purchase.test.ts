import { describe, expect, it } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
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

  // ADR-016 step 4: create_transaction (the god unified tool) is retired — add_card_purchase is
  // now the sole card-purchase entry point, so there's no sibling tool left to compare parity
  // against. The boundary-rejection cases it used to cover directly (empty category/subCategory/
  // card) are asserted below instead.
  it('rejects an explicitly empty category at the schema boundary', async () => {
    const stamp2 = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'add_card_purchase',
            arguments: {
              description: `Empty category ${stamp2}`,
              amount: 10,
              type: 'expense',
              card: `AddPurchase Empty Category Card ${stamp2}`,
              category: '',
              idempotencyKey: `add-purchase-empty-category-${stamp2}`,
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('rejects an explicitly empty subCategory at the schema boundary', async () => {
    const stamp2 = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'add_card_purchase',
            arguments: {
              description: `Empty subCategory ${stamp2}`,
              amount: 10,
              type: 'expense',
              card: `AddPurchase Empty SubCategory Card ${stamp2}`,
              subCategory: '',
              idempotencyKey: `add-purchase-empty-subcategory-${stamp2}`,
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('rejects an explicitly empty card at the schema boundary', async () => {
    const stamp2 = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      // card: '' is especially confusing without this guard: it's treated as "no card" downstream
      // and would trigger an unknown_card resolution error instead of failing fast here.
      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'add_card_purchase',
            arguments: {
              description: `Empty card ${stamp2}`,
              amount: 10,
              type: 'expense',
              card: '',
              idempotencyKey: `add-purchase-empty-card-${stamp2}`,
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('import_card_statement dispatches each line to addCardPurchase, attaching its bill', async () => {
    const cardName = `AddPurchase Bulk Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BRL' },
      });

      const result = (await callTool(client, {
        name: 'import_card_statement',
        args: {
          card: cardName,
          items: [
            {
              description: `Bulk card line ${stamp}`,
              amount: 20,
              type: 'expense',
              date: today,
              idempotencyKey: `bulk-card-${stamp}`,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; transaction?: { billId?: string; cardId?: string } }> };

      ensure(result.items?.length === 1, 'expected one statement item result');
      const [cardItem] = result.items;
      expect(cardItem?.status).not.toBe('error');
      ensure(cardItem?.transaction?.billId, 'expected the statement line to be attached to a bill');
    } finally {
      await transport.close();
    }
  });

  // The retired create_transactions_bulk's "rejects a line resolving both account and card via
  // top-level defaults" case is impossible by construction now (ADR-017 step 2): import_card_statement
  // items structurally have no `account` field (mirroring add_card_purchase's own single-purpose
  // schema) — a statement belongs wholly to the ONE card named at the top level. `.strict()` on
  // ImportCardStatementItemSchema (models/creditCard.ts) turns an item-level `account` into a
  // schema-validation error the MCP SDK rejects before the tool handler ever runs — a stronger
  // guarantee than the old per-item runtime `validation` error, since the whole call is refused
  // rather than one item coming back with status: 'error'.
  it('import_card_statement rejects an account field on an item — not part of the schema', async () => {
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

      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'import_card_statement',
            arguments: {
              card: cardName,
              items: [
                {
                  description: `Bulk exclusive line ${stamp}`,
                  amount: 10,
                  type: 'expense',
                  date: today,
                  account: bankName,
                  idempotencyKey: `bulk-exclusive-${stamp}`,
                },
              ],
            },
          },
        },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('unrecognized_keys');
    } finally {
      await transport.close();
    }
  });
});
