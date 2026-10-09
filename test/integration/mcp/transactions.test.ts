import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { toIsoDate } from '../../../src/logic/period.js';
import { transactionErrors } from '../../../src/models/transaction.js';
import {
  callTool,
  callToolError,
  deleteTransactions,
  ensure,
  makeClient,
  preferredAccount,
  searchTransactions,
} from './helpers.js';

describe('MCP integration > transactions', () => {
  let createdTxIds: string[] = [];
  const createdTagIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];

    if (createdTagIds.length) {
      const { client, transport } = makeClient();
      try {
        await client.connect(transport);
        for (const id of [...createdTagIds]) {
          try {
            await callTool(client, { name: 'delete_tag', args: { id } });
          } catch {
            // best-effort
          }
        }
      } finally {
        await transport.close();
        createdTagIds.length = 0;
      }
    }
  });

  it('executes a full create/search/update/delete flow', async () => {
    const stamp = Date.now();
    const txDescription = `INTEGRATION MCP ${stamp}`;
    const txDescriptionUpdated = `${txDescription} UPDATED`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      const toolsResult = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
      const toolNames = new Set(toolsResult.tools.map((t) => t.name));
      // create_transaction (the god unified tool) is retired (ADR-016 step 4) — replaced by the
      // intent-specific tools below. update_transaction/delete_transaction (the god update/delete
      // tools) are retired too (ADR-017 step 1) — replaced by the four aggregate-specific tools.
      // create_transactions_bulk (the god bulk tool) is retired too (ADR-017 step 2) — replaced by
      // the two single-source statement importers, completing "no god write flows" (ADR-017).
      expect(toolNames.has('create_transaction')).toBe(false);
      expect(toolNames.has('update_transaction')).toBe(false);
      expect(toolNames.has('delete_transaction')).toBe(false);
      expect(toolNames.has('create_transactions_bulk')).toBe(false);
      expect(toolNames.has('add_account_expense')).toBe(true);
      expect(toolNames.has('add_account_income')).toBe(true);
      expect(toolNames.has('add_card_purchase')).toBe(true);
      expect(toolNames.has('search_transactions')).toBe(true);
      expect(toolNames.has('update_account_transaction')).toBe(true);
      expect(toolNames.has('delete_account_transaction')).toBe(true);
      expect(toolNames.has('update_card_transaction')).toBe(true);
      expect(toolNames.has('delete_card_transaction')).toBe(true);
      expect(toolNames.has('import_card_statement')).toBe(true);
      expect(toolNames.has('import_account_statement')).toBe(true);

      let accountName: string;
      if (preferredAccount) {
        accountName = preferredAccount;
      } else {
        await callTool(client, {
          name: 'create_account',
          args: { name: `Integration Test ${stamp}`, type: 'checking', currency: 'BRL', initialBalance: 0 },
        });
        accountName = `Integration Test ${stamp}`;
      }

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: txDescription,
          amount: 0.01,
          date: today,
          account: accountName,
          category: 'Other',
        },
      })) as { transaction?: { id?: string }; created?: boolean };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);
      expect(created.created).toBe(true);

      const found = (await searchTransactions(client, { text: txDescription, limit: 10 })) as Array<{ id?: string }>;
      expect(found.some((tx) => tx.id === txId)).toBe(true);

      const updated = (await callTool(client, {
        name: 'update_account_transaction',
        args: { id: txId, description: txDescriptionUpdated },
      })) as { description?: string };
      expect(updated.description).toBe(txDescriptionUpdated);

      const dryRun = (await callTool(client, {
        name: 'delete_account_transaction',
        args: { id: txId },
      })) as { dryRun?: boolean; deleted?: boolean };
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.deleted).toBe(false);

      const deleted = (await callTool(client, {
        name: 'delete_account_transaction',
        args: { id: txId, confirm: true },
      })) as { deleted?: boolean };
      expect(deleted.deleted).toBe(true);
      createdTxIds = createdTxIds.filter((id) => id !== txId);

      const afterDelete = (await searchTransactions(client, {
        text: txDescriptionUpdated,
        limit: 10,
      })) as Array<{ id?: string }>;
      expect(afterDelete.some((tx) => tx.id === txId)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it('search_transactions treats whitespace-only text as no text filter, not as match-nothing', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Whitespace search ${stamp}`,
          amount: 1,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      const results = (await searchTransactions(client, { text: '   ', limit: 200 })) as Array<{ id?: string }>;

      expect(results.some((tx) => tx.id === txId)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('search_transactions rejects month/year combined with from/to', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const { error } = (await callToolError(client, {
        name: 'search_transactions',
        args: { month: 9, year: 2026, to: '2026-10-01', limit: 10 },
      })) as { error: unknown };
      expect(error).toEqual(transactionErrors.exclusivePeriodRange);
    } finally {
      await transport.close();
    }
  });

  it('search_transactions rejects an explicitly empty category at the schema boundary', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      // CategoryFieldsSchema requires category/subCategory to be non-empty (.min(1)) when
      // provided, so '' never reaches resolution — the MCP SDK rejects it against inputSchema
      // before our handler ever runs. The result is isError: true with a raw zod "too_small"
      // validation message (not our own {error: {code, ...}} JSON envelope, since our handler —
      // and therefore fromResult/jsonError — is never invoked), so this reads the response
      // directly instead of going through callTool/callToolError's JSON-payload parsing.
      const result = await client.request(
        { method: 'tools/call', params: { name: 'search_transactions', arguments: { category: '', limit: 10 } } },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('search_transactions rejects an explicitly empty subCategory at the same schema boundary', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      // SearchTransactionsSchema's category field has its own coverage above; subCategory is a
      // separate field declaration in the same schema and could independently regress (e.g. an
      // edit that touches only this line) without that test catching it.
      const result = await client.request(
        { method: 'tools/call', params: { name: 'search_transactions', arguments: { subCategory: '', limit: 10 } } },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('update_account_transaction rejects an explicitly empty category at the same schema boundary', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Update empty category ${stamp}`,
          amount: 10,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // UpdateTransactionSchema is its own contract — the same regression argument as create: a
      // future edit here could independently drop the CategoryFieldsSchema derivation without
      // create/search noticing.
      const result = await client.request(
        {
          method: 'tools/call',
          params: { name: 'update_account_transaction', arguments: { id: txId, category: '' } },
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

  it('update_account_transaction rejects an explicitly empty subCategory at the same schema boundary', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Update empty subCategory ${stamp}`,
          amount: 10,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // UpdateTransactionSchema's category field has its own coverage above; subCategory is a
      // separate field declaration in the same schema and could independently regress without
      // that test catching it.
      const result = await client.request(
        {
          method: 'tools/call',
          params: { name: 'update_account_transaction', arguments: { id: txId, subCategory: '' } },
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

  it('update_account_transaction rejects an explicitly empty account at the schema boundary', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Update empty account ${stamp}`,
          amount: 10,
        },
      })) as { transaction?: { id?: string } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      const result = await client.request(
        {
          method: 'tools/call',
          params: { name: 'update_account_transaction', arguments: { id: txId, account: '' } },
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

  it('search_transactions rejects an explicitly empty account at the schema boundary', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const result = await client.request(
        { method: 'tools/call', params: { name: 'search_transactions', arguments: { account: '', limit: 10 } } },
        CallToolResultSchema,
      );
      expect(result.isError).toBe(true);
      const text = result.content.find((item) => item.type === 'text')?.text;
      expect(text).toContain('too_small');
    } finally {
      await transport.close();
    }
  });

  it('import_account_statement rejects an explicitly empty top-level account', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'import_account_statement',
            arguments: {
              account: '',
              items: [
                {
                  description: `Bulk empty account ${stamp}`,
                  amount: 10,
                  type: 'expense',
                },
              ],
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

  it('account statement import returns per-item status and treats re-imports as duplicates', async () => {
    const stamp = Date.now();
    const accountName = `Bulk Import ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const result = (await callTool(client, {
        name: 'import_account_statement',
        args: {
          account: accountName,
          items: [
            {
              description: 'iFood refeição',
              amount: 45,
              type: 'expense',
              date: today,
            },
            {
              description: 'Salário empresa',
              amount: 5000,
              type: 'income',
              date: today,
            },
            {
              description: 'Uber corrida',
              amount: 22.5,
              type: 'expense',
              date: today,
            },
          ],
        },
      })) as {
        summary?: { created?: number; needsReview?: number; duplicates?: number; errors?: number };
        items?: Array<{ status?: string; transaction?: { id?: string } }>;
      };

      expect(result.items?.length).toBe(3);
      for (const item of result.items ?? []) {
        expect(['created', 'needs_review']).toContain(item.status);
        if (item.transaction?.id) createdTxIds.push(item.transaction.id);
      }
      const { created = 0, needsReview = 0 } = result.summary ?? {};
      expect(created + needsReview).toBe(3);

      // Re-importing the same items is idempotent — returns duplicates, not new transactions
      const reimport = (await callTool(client, {
        name: 'import_account_statement',
        args: {
          account: accountName,
          items: [
            {
              description: 'iFood refeição',
              amount: 45,
              type: 'expense',
              date: today,
            },
          ],
        },
      })) as { summary?: { duplicates?: number } };
      expect(reimport.summary?.duplicates).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it('account statement import persists and returns note per item', async () => {
    const stamp = Date.now();
    const accountName = `Bulk Note ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const result = (await callTool(client, {
        name: 'import_account_statement',
        args: {
          account: accountName,
          items: [
            {
              description: 'With note',
              amount: 10,
              type: 'expense',
              date: today,
              note: 'reembolsável',
            },
            {
              description: 'Without note',
              amount: 20,
              type: 'expense',
              date: today,
            },
          ],
        },
      })) as { items?: Array<{ status?: string; transaction?: { id?: string; note?: string } }> };

      const items = result.items ?? [];
      expect(items.length).toBe(2);
      for (const item of items) {
        expect(['created', 'needs_review']).toContain(item.status);
        ensure(item.transaction?.id, 'Bulk item missing transaction id');
        createdTxIds.push(item.transaction.id);
      }

      const first = items[0]?.transaction;
      const second = items[1]?.transaction;
      ensure(first, 'First bulk item missing transaction');
      ensure(second, 'Second bulk item missing transaction');
      expect(first.note).toBe('reembolsável');
      expect(second.note).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it('persists two near-identical BTC lines without falsely deduping them (crypto idempotency precision)', async () => {
    const stamp = Date.now();
    const accountName = `Bulk BTC ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BTC', initialBalance: 0 },
      });

      // Both round to 0.12 at a flat 2 decimals — the old idempotency key would collide them into
      // one "duplicate", silently dropping the second line. At BTC's own 8 decimals they're distinct.
      const result = (await callTool(client, {
        name: 'import_account_statement',
        args: {
          account: accountName,
          items: [
            { description: 'BTC buy', amount: 0.12340001, type: 'expense', date: today },
            { description: 'BTC buy', amount: 0.12349999, type: 'expense', date: today },
          ],
        },
      })) as {
        summary?: { created?: number; needsReview?: number; duplicates?: number; errors?: number };
        items?: Array<{ status?: string; transaction?: { id?: string; amount?: number } }>;
      };

      const items = result.items ?? [];
      expect(items.length).toBe(2);
      for (const item of items) {
        expect(['created', 'needs_review']).toContain(item.status);
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
    const stamp = Date.now();
    const accountName = `Bulk BTC Dup ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BTC', initialBalance: 0 },
      });

      const item = { description: 'BTC recurring buy', amount: 0.00123456, type: 'expense', date: today };

      const first = (await callTool(client, {
        name: 'import_account_statement',
        args: { account: accountName, items: [item] },
      })) as { items?: Array<{ status?: string; transaction?: { id?: string } }> };
      const createdItem = first.items?.[0];
      ensure(createdItem?.transaction?.id, 'first BTC import missing transaction id');
      createdTxIds.push(createdItem.transaction.id);

      const reimport = (await callTool(client, {
        name: 'import_account_statement',
        args: { account: accountName, items: [item] },
      })) as { summary?: { duplicates?: number } };
      expect(reimport.summary?.duplicates).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it('creates transaction with tags and returns them in the view', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Tags Tx ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const workTag = (await callTool(client, { name: 'create_tag', args: { name: `work-${stamp}` } })) as {
        id?: string;
      };
      const travelTag = (await callTool(client, { name: 'create_tag', args: { name: `travel-${stamp}` } })) as {
        id?: string;
      };
      ensure(workTag.id, 'Work tag id missing');
      ensure(travelTag.id, 'Travel tag id missing');
      createdTagIds.push(workTag.id, travelTag.id);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Tagged tx ${stamp}`,
          amount: 10,
          account,
          category: 'Other',
          tags: [`work-${stamp}`, `travel-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      expect(created.transaction?.tags).toContain(`work-${stamp}`);
      expect(created.transaction?.tags).toContain(`travel-${stamp}`);
    } finally {
      await transport.close();
    }
  });

  it('update_account_transaction replaces the tag set', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Tags Update ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const tagA = (await callTool(client, { name: 'create_tag', args: { name: `tag-a-${stamp}` } })) as {
        id?: string;
      };
      const tagB = (await callTool(client, { name: 'create_tag', args: { name: `tag-b-${stamp}` } })) as {
        id?: string;
      };
      ensure(tagA.id, 'Tag A id missing');
      ensure(tagB.id, 'Tag B id missing');
      createdTagIds.push(tagA.id, tagB.id);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Update tags tx ${stamp}`,
          amount: 5,
          account,
          category: 'Other',
          tags: [`tag-a-${stamp}`],
        },
      })) as { transaction?: { id?: string } };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // Replace tag-a with tag-b
      const updated = (await callTool(client, {
        name: 'update_account_transaction',
        args: { id: txId, tags: [`tag-b-${stamp}`] },
      })) as { tags?: string[] };
      expect(updated.tags).toContain(`tag-b-${stamp}`);
      expect(updated.tags).not.toContain(`tag-a-${stamp}`);
    } finally {
      await transport.close();
    }
  });

  it('update_account_transaction with empty tags removes all tags', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Tags Clear ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const tag = (await callTool(client, { name: 'create_tag', args: { name: `clear-tag-${stamp}` } })) as {
        id?: string;
      };
      ensure(tag.id, 'Tag id missing');
      createdTagIds.push(tag.id);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Clear tags tx ${stamp}`,
          amount: 3,
          account,
          category: 'Other',
          tags: [`clear-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string } };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      const updated = (await callTool(client, {
        name: 'update_account_transaction',
        args: { id: txId, tags: [] },
      })) as { tags?: string[] };
      expect(updated.tags).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it('search_transactions filters by tag', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Tags Search ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const tag = (await callTool(client, { name: 'create_tag', args: { name: `search-tag-${stamp}` } })) as {
        id?: string;
      };
      ensure(tag.id, 'Tag id missing');
      createdTagIds.push(tag.id);

      const today = toIsoDate(new Date());

      const taggedTx = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Tagged for search ${stamp}`,
          amount: 7,
          date: today,
          account,
          category: 'Other',
          tags: [`search-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string } };
      const taggedTxId = taggedTx.transaction?.id;
      ensure(taggedTxId, 'Tagged transaction id missing');
      createdTxIds.push(taggedTxId);

      const untaggedTx = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Untagged for search ${stamp}`,
          amount: 8,
          date: today,
          account,
          category: 'Other',
        },
      })) as { transaction?: { id?: string } };
      const untaggedTxId = untaggedTx.transaction?.id;
      ensure(untaggedTxId, 'Untagged transaction id missing');
      createdTxIds.push(untaggedTxId);

      const results = (await searchTransactions(client, {
        tags: [`search-tag-${stamp}`],
        limit: 50,
      })) as Array<{ id?: string }>;

      const ids = results.map((t) => t.id);
      expect(ids).toContain(taggedTxId);
      expect(ids).not.toContain(untaggedTxId);
    } finally {
      await transport.close();
    }
  });

  // Issue #3: tag filter was applied per-row, truncating the tags[] of matched transactions
  // to only the matching subset instead of returning all tags.
  it('search_transactions returns the full tag set on matched transactions, not just the filter tag', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Tags Full Set ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const tagA = (await callTool(client, { name: 'create_tag', args: { name: `full-a-${stamp}` } })) as {
        id?: string;
      };
      const tagB = (await callTool(client, { name: 'create_tag', args: { name: `full-b-${stamp}` } })) as {
        id?: string;
      };
      ensure(tagA.id, 'Tag A id missing');
      ensure(tagB.id, 'Tag B id missing');
      createdTagIds.push(tagA.id, tagB.id);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Full tagset tx ${stamp}`,
          amount: 11,
          account,
          category: 'Other',
          tags: [`full-a-${stamp}`, `full-b-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // Search by only one of the two tags — the result must still carry both
      const results = (await searchTransactions(client, {
        tags: [`full-a-${stamp}`],
        limit: 50,
      })) as Array<{ id?: string; tags?: string[] }>;

      const match = results.find((tx) => tx.id === txId);
      expect(match).toBeDefined();
      expect(match?.tags).toContain(`full-a-${stamp}`);
      expect(match?.tags).toContain(`full-b-${stamp}`);
    } finally {
      await transport.close();
    }
  });

  // Issue #1: attachTags used MERGE instead of MATCH, creating orphan (:Tag) nodes without
  // id when a non-existent tag name was passed — violating the Tag schema.
  it('add_account_expense silently ignores tag names that do not exist', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Ghost Tag ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Ghost tag tx ${stamp}`,
          amount: 1,
          account,
          category: 'Other',
          tags: [`nonexistent-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // Non-existent tag must be silently dropped — no orphan node created
      expect(created.transaction?.tags).toEqual([]);

      // Orphan node must not appear in list_tags
      const tags = (await callTool(client, { name: 'list_tags', args: {} })) as Array<{ name?: string }>;
      expect(tags.some((t) => t.name === `nonexistent-tag-${stamp}`)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  // A repeated name resolves to a repeated id, which would violate transaction_tags' composite
  // (transaction_id, tag_id) primary key on insert if not deduped before the write.
  it('add_account_expense with a duplicate tag name in the request does not error, and dedupes', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Duplicate Tag ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const tag = (await callTool(client, { name: 'create_tag', args: { name: `dup-tag-${stamp}` } })) as {
        id?: string;
      };
      ensure(tag.id, 'Tag id missing');
      createdTagIds.push(tag.id);

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Duplicate tag tx ${stamp}`,
          amount: 1,
          account,
          category: 'Other',
          tags: [`dup-tag-${stamp}`, `dup-tag-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      expect(created.transaction?.tags).toEqual([`dup-tag-${stamp}`]);
    } finally {
      await transport.close();
    }
  });

  // Regression guard: collect(DISTINCT tag.name) on an OPTIONAL MATCH returns []
  // (not [null]) for transactions with no TAGGED_WITH edges, because Cypher's
  // collect() skips nulls by design. This test confirms untagged transactions
  // parse without error and expose tags: [].
  it('add_account_expense without tags returns tags: [] — not null or [null]', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `No Tags ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      // Create with no tags field at all
      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `No tags tx ${stamp}`,
          amount: 5,
          account,
          category: 'Other',
        },
      })) as { transaction?: { id?: string; tags?: string[] } };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // create response: tags must be an empty array, not null or [null]
      expect(Array.isArray(created.transaction?.tags)).toBe(true);
      expect(created.transaction?.tags).toEqual([]);

      // search response: same guarantee on the read path
      const results = (await searchTransactions(client, {
        text: `No tags tx ${stamp}`,
        limit: 10,
      })) as Array<{ id?: string; tags?: string[] }>;

      const match = results.find((tx) => tx.id === txId);
      expect(match).toBeDefined();
      expect(Array.isArray(match?.tags)).toBe(true);
      expect(match?.tags).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it('note round-trips via create and search_transactions', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Note RT ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Note roundtrip ${stamp}`,
          amount: 10,
          account,
          category: 'Other',
          note: 'split com João',
        },
      })) as { transaction?: { id?: string; note?: string } };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      expect(created.transaction?.note).toBe('split com João');

      const results = (await searchTransactions(client, {
        text: `Note roundtrip ${stamp}`,
        limit: 10,
      })) as Array<{ id?: string; note?: string }>;

      const match = results.find((tx) => tx.id === txId);
      expect(match).toBeDefined();
      expect(match?.note).toBe('split com João');
    } finally {
      await transport.close();
    }
  });

  it('update_account_transaction sets, clears, and leaves note untouched', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Note Update ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Note update ${stamp}`,
          amount: 20,
          account,
          category: 'Other',
        },
      })) as { transaction?: { id?: string; note?: string } };

      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      // Initially no note
      expect(created.transaction?.note).toBeUndefined();

      // Set a note
      const withNote = (await callTool(client, {
        name: 'update_account_transaction',
        args: { id: txId, note: 'reembolsável' },
      })) as { note?: string };
      expect(withNote.note).toBe('reembolsável');

      // Omit note — should remain unchanged
      const unchanged = (await callTool(client, {
        name: 'update_account_transaction',
        args: { id: txId, description: `Note update ${stamp} v2` },
      })) as { note?: string };
      expect(unchanged.note).toBe('reembolsável');

      // Clear note with empty string
      const cleared = (await callTool(client, {
        name: 'update_account_transaction',
        args: { id: txId, note: '' },
      })) as { note?: string };
      expect(cleared.note).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it('correcting a category via update_account_transaction teaches future auto-classification', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Merchant Learn ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const category = `Merchant Learn Category ${stamp}`;
      await callTool(client, { name: 'create_category', args: { name: category, kind: 'expense' } });

      // Letters-only so `normalizeMerchant` (which strips digits) still keys on something unique
      // per test run — a stamp alone would collide across runs once its digits are stripped.
      // Mapping digits to letters (rather than stripping them) keeps all 32 hex characters, so the
      // result is always non-empty and always letter-only — stripping digits could (rarely) yield
      // an empty or short token and risk a cross-run merchant-key collision.
      const merchant = randomUUID()
        .replace(/-/g, '')
        .replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit)));
      const merchantDescription = (n: number) => `${merchant} purchase ${n}`;

      // First occurrence: nothing has taught this merchant anything yet — auto-classifies to none.
      const first = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: merchantDescription(1),
          amount: 10,
          account,
        },
      })) as { transaction?: { id?: string }; classification?: { method?: string } };
      const firstId = first.transaction?.id;
      ensure(firstId, 'First transaction id missing');
      createdTxIds.push(firstId);
      expect(first.classification?.method).toBe('none');

      // Correct its category — this is the "user teaches the merchant" moment.
      await callTool(client, {
        name: 'update_account_transaction',
        args: { id: firstId, category },
      });

      // Second occurrence of the SAME merchant, again with no category given: auto-classification
      // should now pick up what the correction taught it, via merchant_category (not user input).
      const second = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: merchantDescription(2),
          amount: 12,
          account,
        },
      })) as { transaction?: { id?: string; categoryName?: string }; classification?: { method?: string } };
      const secondId = second.transaction?.id;
      ensure(secondId, 'Second transaction id missing');
      createdTxIds.push(secondId);

      expect(second.classification?.method).toBe('history');
      expect(second.transaction?.categoryName).toBe(category);
    } finally {
      await transport.close();
    }
  });

  // Tags are case-sensitive: "Work" and "work" are distinct tags.
  // Attaching with a different casing silently drops the tag (no match), and
  // search by a different casing returns no results.
  it('tags are case-sensitive — different casing does not match', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const account = `Case Tag ${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: account, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      // Create tag with uppercase name
      const tag = (await callTool(client, { name: 'create_tag', args: { name: `CASE-TAG-${stamp}` } })) as {
        id?: string;
      };
      ensure(tag.id, 'Tag id missing');
      createdTagIds.push(tag.id);

      // Attach using exact same casing — must succeed
      const created = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Case tag tx ${stamp}`,
          amount: 4,
          account,
          category: 'Other',
          tags: [`CASE-TAG-${stamp}`],
        },
      })) as { transaction?: { id?: string; tags?: string[] } };
      const txId = created.transaction?.id;
      ensure(txId, 'Transaction id missing');
      createdTxIds.push(txId);

      expect(created.transaction?.tags).toContain(`CASE-TAG-${stamp}`);

      // Search using wrong casing — must NOT find the transaction
      const results = (await searchTransactions(client, {
        tags: [`case-tag-${stamp}`],
        limit: 50,
      })) as Array<{ id?: string }>;
      expect(results.some((tx) => tx.id === txId)).toBe(false);
    } finally {
      await transport.close();
    }
  });
});
