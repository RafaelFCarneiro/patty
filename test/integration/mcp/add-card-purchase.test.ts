import { afterEach, describe, expect, it } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, callToolError, deleteTransactions, ensure, makeClient } from './helpers.js';

describe('MCP integration > add_card_purchase (ADR-016 step 2)', () => {
  const now = new Date();
  const stamp = now.getTime();
  // Pin to day 15 so the purchase always falls within the closingDay=28 cycle.
  const pinned = new Date(now.getFullYear(), now.getMonth(), 15);
  const today = toIsoDate(pinned);
  const month = pinned.getMonth() + 1;
  const year = pinned.getFullYear();
  const nextCycle = month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

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
        },
      })) as { error?: { code?: string } };
      expect(autoErr.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('is idempotent — a repeat call with identical input returns the existing purchase', async () => {
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

  it('persists two near-identical BTC lines without falsely deduping them (crypto idempotency precision)', async () => {
    const cardName = `AddPurchase BTC Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BTC' },
      });

      // Both round to 0.12 at a flat 2 decimals — the old idempotency key would collide them into
      // one "duplicate", silently dropping the second line. At BTC's own 8 decimals they're distinct.
      const result = (await callTool(client, {
        name: 'import_card_statement',
        args: {
          card: cardName,
          items: [
            { description: 'BTC buy', amount: 0.12340001, type: 'expense', date: today },
            { description: 'BTC buy', amount: 0.12349999, type: 'expense', date: today },
          ],
        },
      })) as {
        summary?: { created?: number; needsReview?: number; duplicates?: number };
        items?: Array<{ status?: string; transaction?: { id?: string; amount?: number } }>;
      };

      const items = result.items ?? [];
      expect(items.length).toBe(2);
      for (const item of items) {
        if (item.transaction?.id) createdTxIds.push(item.transaction.id);
      }
      const { created = 0, needsReview = 0, duplicates = 0 } = result.summary ?? {};
      expect(created + needsReview).toBe(2);
      expect(duplicates).toBe(0);
      expect(items.map((i) => i.transaction?.amount).sort()).toEqual([0.12340001, 0.12349999].sort());
    } finally {
      await transport.close();
    }
  });

  it('still dedupes a true duplicate BTC line on re-import (regression)', async () => {
    const cardName = `AddPurchase BTC Dup Card ${stamp}`;
    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_credit_card',
        args: { name: cardName, closingDay: 28, dueDay: 5, currency: 'BTC' },
      });

      const item = { description: 'BTC recurring buy', amount: 0.00123456, type: 'expense', date: today };

      const first = (await callTool(client, {
        name: 'import_card_statement',
        args: { card: cardName, items: [item] },
      })) as { items?: Array<{ status?: string; transaction?: { id?: string } }> };
      const createdItem = first.items?.[0];
      expect(createdItem?.status).not.toBe('error');
      if (createdItem?.transaction?.id) createdTxIds.push(createdItem.transaction.id);

      const reimport = (await callTool(client, {
        name: 'import_card_statement',
        args: { card: cardName, items: [item] },
      })) as { summary?: { duplicates?: number } };
      expect(reimport.summary?.duplicates).toBe(1);
    } finally {
      await transport.close();
    }
  });

  // Two lines landing on the SAME brand-new cycle don't coordinate inside one batch — the second
  // line's flow simply reads the bill the first line's flow already committed (each line is its
  // own transaction, applied sequentially).
  it('two lines sharing a brand-new bill cycle attach to exactly one bill, not two', async () => {
    const cardName = `AddPurchase Bulk SharedBill Card ${stamp}`;
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
              description: `Shared bill line A ${stamp}`,
              amount: 10,
              type: 'expense',
              date: today,
            },
            {
              description: `Shared bill line B ${stamp}`,
              amount: 15,
              type: 'expense',
              date: today,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; transaction?: { billId?: string } }> };

      ensure(result.items?.length === 2, 'expected two statement item results');
      const [lineA, lineB] = result.items;
      expect(lineA?.status).not.toBe('error');
      expect(lineB?.status).not.toBe('error');
      ensure(lineA?.transaction?.billId, 'expected line A to be attached to a bill');
      ensure(lineB?.transaction?.billId, 'expected line B to be attached to a bill');
      expect(lineB.transaction.billId).toBe(lineA.transaction.billId);

      const bill = (await callTool(client, { name: 'get_bill', args: { card: cardName, month, year } })) as {
        total?: number;
      };
      expect(bill.total).toBe(25);
    } finally {
      await transport.close();
    }
  });

  it('a line failing validation errors while sibling lines still import (partial success)', async () => {
    const cardName = `AddPurchase Bulk Partial Card ${stamp}`;
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
              description: `Partial line A ${stamp}`,
              amount: 10,
              type: 'expense',
              date: today,
            },
            {
              // billMonth without billYear fails the domain's pairing guard
              // (cardErrors.billPeriodIncomplete) — a per-line business rejection, not a schema
              // one, since the schema leaves both fields independently optional.
              description: `Partial line invalid ${stamp}`,
              amount: 20,
              type: 'expense',
              date: today,
              billMonth: month,
            },
            {
              description: `Partial line C ${stamp}`,
              amount: 30,
              type: 'expense',
              date: today,
            },
          ],
        },
      })) as {
        summary?: { created?: number; needsReview?: number; errors?: number };
        items?: Array<{ status?: string; transaction?: { id?: string } }>;
      };

      ensure(result.items?.length === 3, 'expected three statement item results');
      expect(result.items[0]?.status).not.toBe('error');
      expect(result.items[1]?.status).toBe('error');
      expect(result.items[2]?.status).not.toBe('error');
      expect(result.summary?.errors).toBe(1);
      expect((result.summary?.created ?? 0) + (result.summary?.needsReview ?? 0)).toBe(2);
    } finally {
      await transport.close();
    }
  });

  it('a line targeting an already-paid bill cycle errors without aborting sibling lines', async () => {
    const cardName = `AddPurchase Bulk PaidCycle Card ${stamp}`;
    const bankName = `AddPurchase Bulk PaidCycle Bank ${stamp}`;
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

      // Open and pay off the NEXT cycle up front, so a statement line explicitly targeting it
      // lands on a bill that's already paid.
      await callTool(client, {
        name: 'add_card_purchase',
        args: {
          description: `Paid-cycle seed ${stamp}`,
          amount: 40,
          type: 'expense',
          date: today,
          card: cardName,
          billMonth: nextCycle.month,
          billYear: nextCycle.year,
        },
      });
      await callTool(client, {
        name: 'pay_bill',
        args: { card: cardName, month: nextCycle.month, year: nextCycle.year, account: bankName },
      });

      const result = (await callTool(client, {
        name: 'import_card_statement',
        args: {
          card: cardName,
          items: [
            {
              description: `Paid-cycle line ${stamp}`,
              amount: 5,
              type: 'expense',
              date: today,
              billMonth: nextCycle.month,
              billYear: nextCycle.year,
            },
            {
              description: `Current-cycle line ${stamp}`,
              amount: 8,
              type: 'expense',
              date: today,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; transaction?: { id?: string } }> };

      ensure(result.items?.length === 2, 'expected two statement item results');
      expect(result.items[0]?.status).toBe('error');
      expect(result.items[1]?.status).not.toBe('error');
      ensure(result.items[1]?.transaction?.id, 'expected the current-cycle line to still be created');
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
