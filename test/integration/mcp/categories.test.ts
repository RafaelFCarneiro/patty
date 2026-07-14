import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callTool, callToolError, deleteTransactions, makeClient } from './helpers.js';

type Category = { id: string; name: string; kind: string; names: Record<string, string> | null };
type ErrorPayload<T = unknown> = { error: T };
type InUseError = {
  code: string;
  entity: string;
  name: string;
  references: { transactions: number; recurring: number; subCategories: number };
};

describe('MCP integration > categories', () => {
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  const stamp = Date.now();
  const accountName = `cat-test-acct-${stamp}`;
  const createdTxIds: string[] = [];

  beforeAll(async () => {
    const c = makeClient();
    client = c.client;
    transport = c.transport;
    await client.connect(transport);
    await callTool(client, {
      name: 'create_account',
      args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
    });
  });

  afterAll(async () => {
    await deleteTransactions(createdTxIds);
    await callTool(client, { name: 'set_locale', args: { locale: 'en', source: 'explicit' } });
    await transport.close();
  });

  it('list_categories returns results sorted by locale-resolved name', async () => {
    await callTool(client, { name: 'set_locale', args: { locale: 'pt', source: 'explicit' } });
    const categories = (await callTool(client, { name: 'list_categories' })) as Category[];
    const names = categories.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'pt', { sensitivity: 'base' }));
    expect(names).toEqual(sorted);
  });

  it('delete_category succeeds for an unreferenced user category', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `del-cat-${stamp}`, kind: 'expense' },
    })) as Category;

    const result = (await callTool(client, { name: 'delete_category', args: { name: cat.name } })) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(true);

    const all = (await callTool(client, { name: 'list_categories' })) as Category[];
    expect(all.some((c) => c.id === cat.id)).toBe(false);
  });

  it('delete_category blocked when a transaction references it', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `in-use-cat-${stamp}`, kind: 'expense' },
    })) as Category;

    const txResult = (await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: `test-del-cat-${stamp}`,
        amount: 10,
        date: '2026-01-15',
        account: accountName,
        category: cat.name,
        idempotencyKey: `del-cat-tx-${stamp}`,
      },
    })) as { transaction: { id: string } };
    createdTxIds.push(txResult.transaction.id);

    const { error } = (await callToolError(client, {
      name: 'delete_category',
      args: { name: cat.name },
    })) as ErrorPayload<InUseError>;
    expect(error.code).toBe('in_use');
    expect(error.entity).toBe('category');
    expect(error.references.transactions).toBeGreaterThanOrEqual(1);

    const all = (await callTool(client, { name: 'list_categories' })) as Category[];
    expect(all.some((c) => c.id === cat.id)).toBe(true);
  });

  it('delete_category blocked when it has sub-categories', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `parent-cat-${stamp}`, kind: 'expense' },
    })) as Category;

    await callTool(client, {
      name: 'create_sub_category',
      args: { name: `child-sub-${stamp}`, parentId: cat.id },
    });

    const { error } = (await callToolError(client, {
      name: 'delete_category',
      args: { name: cat.name },
    })) as ErrorPayload<InUseError>;
    expect(error.code).toBe('in_use');
    expect(error.references.subCategories).toBeGreaterThanOrEqual(1);
  });

  it('delete_category succeeds when only merchant rules reference it (not a blocker)', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `merchant-cat-${stamp}`, kind: 'expense' },
    })) as Category;

    // Create a transaction WITHOUT a category so auto-classification sets a merchantKey
    const txResult = (await callTool(client, {
      name: 'add_account_expense',
      args: {
        description: 'Netflix subscription',
        amount: 25,
        date: '2026-01-20',
        account: accountName,
        idempotencyKey: `merchant-learn-${stamp}`,
      },
    })) as { transaction: { id: string } };
    createdTxIds.push(txResult.transaction.id);

    // Correct the category → the merchant-learning correction writes a merchant_category row
    await callTool(client, {
      name: 'update_account_transaction',
      args: { id: txResult.transaction.id, category: cat.name },
    });

    // Delete the transaction so only the learned merchant rule remains
    await callTool(client, {
      name: 'delete_account_transaction',
      args: { id: txResult.transaction.id, confirm: true },
    });
    createdTxIds.splice(createdTxIds.indexOf(txResult.transaction.id), 1);

    // Category should still delete — merchant rules are not a blocker
    const result = (await callTool(client, { name: 'delete_category', args: { name: cat.name } })) as {
      deleted: boolean;
    };
    expect(result.deleted).toBe(true);

    const allAfter = (await callTool(client, { name: 'list_categories' })) as Category[];
    expect(allAfter.some((c) => c.id === cat.id)).toBe(false);
  });

  it('delete_category blocked when a recurring rule references it', async () => {
    const cat = (await callTool(client, {
      name: 'create_category',
      args: { name: `rec-cat-${stamp}`, kind: 'expense' },
    })) as Category;

    await callTool(client, {
      name: 'create_recurring',
      args: {
        description: `Recurring-${stamp}`,
        amount: 50,
        type: 'expense',
        period: 'monthly',
        startDate: '2026-02-01',
        account: accountName,
        category: cat.name,
      },
    });

    const { error } = (await callToolError(client, {
      name: 'delete_category',
      args: { name: cat.name },
    })) as ErrorPayload<InUseError>;
    expect(error.code).toBe('in_use');
    expect(error.entity).toBe('category');
    expect(error.references.recurring).toBeGreaterThanOrEqual(1);
  });

  it('delete_category returns unknown_category for non-existent name', async () => {
    const { error } = (await callToolError(client, {
      name: 'delete_category',
      args: { name: 'nonexistent-category-xyz-999' },
    })) as ErrorPayload<{ code: string }>;
    expect(error.code).toBe('unknown_category');
  });
});
