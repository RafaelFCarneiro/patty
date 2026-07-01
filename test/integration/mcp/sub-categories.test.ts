import { afterEach, describe, expect, it } from 'vitest';
import { callTool, callToolError, deleteTransactions, ensure, makeClient } from './helpers.js';

// Sub-categories have no delete tool — the ephemeral test DB is wiped per run.
// We only need to clean up transactions to avoid cross-test interference.
const createdTxIds: string[] = [];

afterEach(async () => {
  await deleteTransactions([...createdTxIds]);
  createdTxIds.length = 0;
});

type SubCategory = {
  id?: string;
  name?: string;
  parentId?: string;
  parentName?: string;
  kind?: string;
};
type TransactionView = {
  id?: string;
  subCategoryId?: string;
  subCategoryName?: string;
  categoryId?: string;
  categoryName?: string;
};
type ErrorPayload<T = unknown> = { error: T };
type InUseError = {
  code: string;
  entity: string;
  name: string;
  references: { transactions: number; recurring: number; subCategories: number };
};

describe('MCP integration > sub-categories', () => {
  it('create_sub_category returns sub-category with parent info inherited kind', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Restaurante-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;

      ensure(sc.id, 'subCategory id missing');
      expect(sc.name).toBe(`Restaurante-${stamp}`);
      expect(sc.parentId).toBe('cat-food');
      expect(sc.parentName).toBe('Food');
      expect(sc.kind).toBe('expense');
    } finally {
      await transport.close();
    }
  });

  it('create_sub_category rejects duplicate name within same parent', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Mercado-${stamp}`, parentId: 'cat-food' },
      });
      await expect(
        callTool(client, {
          name: 'create_sub_category',
          args: { name: `Mercado-${stamp}`, parentId: 'cat-food' },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('list_sub_categories returns created sub-category', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Padaria-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc.id, 'subCategory id missing');

      const all = (await callTool(client, { name: 'list_sub_categories', args: {} })) as SubCategory[];
      expect(Array.isArray(all)).toBe(true);
      expect(all.some((s) => s.id === sc.id)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('list_sub_categories filtered by parentId only returns children of that parent', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Uber-${stamp}`, parentId: 'cat-transport' },
      });
      await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Ifood-${stamp}`, parentId: 'cat-food' },
      });

      const food = (await callTool(client, {
        name: 'list_sub_categories',
        args: { parentId: 'cat-food' },
      })) as SubCategory[];

      expect(food.every((s) => s.parentId === 'cat-food')).toBe(true);
      expect(food.some((s) => s.name === `Ifood-${stamp}`)).toBe(true);
      expect(food.some((s) => s.name === `Uber-${stamp}`)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it('create_transaction with subCategory sets subCategoryId, subCategoryName, and parent categoryId', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Almoço-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc.id, 'subCategory id missing');

      const result = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Almoço no restaurante',
          amount: 45,
          type: 'expense',
          subCategory: `Almoço-${stamp}`,
          idempotencyKey: `test-subcat-create-${stamp}`,
        },
      })) as { transaction?: TransactionView };

      const tx = result.transaction ?? (result as TransactionView);
      ensure(tx.id, 'transaction id missing');
      createdTxIds.push(tx.id);

      expect(tx.subCategoryId).toBe(sc.id);
      expect(tx.subCategoryName).toBe(`Almoço-${stamp}`);
      expect(tx.categoryId).toBe('cat-food');
      expect(tx.categoryName).toBe('Food');
    } finally {
      await transport.close();
    }
  });

  it('create_transaction rejects expense transaction with income-only category', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, {
          name: 'create_transaction',
          args: {
            description: 'Pagamento errado',
            amount: 100,
            type: 'expense',
            category: 'Salary',
            idempotencyKey: `test-kind-mismatch-${stamp}`,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('create_transaction rejects income transaction with expense-only category', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, {
          name: 'create_transaction',
          args: {
            description: 'Salário errado',
            amount: 5000,
            type: 'income',
            category: 'Food',
            idempotencyKey: `test-income-mismatch-${stamp}`,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('create_transaction rejects providing both category and subCategory', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, {
          name: 'create_transaction',
          args: {
            description: 'Ambiguous',
            amount: 10,
            type: 'expense',
            category: 'Food',
            subCategory: 'something',
            idempotencyKey: `test-both-${stamp}`,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });

  it('update_transaction replaces sub-category', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const sc1 = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `SubA-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      const sc2 = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `SubB-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc1.id, 'sc1 id missing');
      ensure(sc2.id, 'sc2 id missing');

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Refeição',
          amount: 30,
          type: 'expense',
          subCategory: `SubA-${stamp}`,
          idempotencyKey: `test-update-subcat-${stamp}`,
        },
      })) as { transaction?: TransactionView };
      const tx = created.transaction ?? (created as TransactionView);
      ensure(tx.id, 'transaction id missing');
      createdTxIds.push(tx.id);

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: tx.id, subCategory: `SubB-${stamp}` },
      })) as TransactionView;

      expect(updated.subCategoryId).toBe(sc2.id);
      expect(updated.subCategoryName).toBe(`SubB-${stamp}`);
      expect(updated.categoryId).toBe('cat-food');
    } finally {
      await transport.close();
    }
  });

  it('search_transactions filters by subCategory', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `Filter-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc.id, 'subCategory id missing');

      const tx1 = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Com subcategoria',
          amount: 20,
          type: 'expense',
          subCategory: `Filter-${stamp}`,
          idempotencyKey: `test-search-sub-match-${stamp}`,
        },
      })) as { transaction?: TransactionView };
      const tx2 = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Sem subcategoria',
          amount: 20,
          type: 'expense',
          category: 'Food',
          idempotencyKey: `test-search-sub-no-match-${stamp}`,
        },
      })) as { transaction?: TransactionView };

      const t1 = tx1.transaction ?? (tx1 as TransactionView);
      const t2 = tx2.transaction ?? (tx2 as TransactionView);
      ensure(t1.id, 'tx1 id missing');
      ensure(t2.id, 'tx2 id missing');
      createdTxIds.push(t1.id, t2.id);

      const results = (await callTool(client, {
        name: 'search_transactions',
        args: { subCategory: `Filter-${stamp}` },
      })) as TransactionView[];

      expect(results.some((t) => t.id === t1.id)).toBe(true);
      expect(results.some((t) => t.id === t2.id)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it('category_kind_mismatch error includes a hint with the corrective type', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callToolError(client, {
        name: 'create_transaction',
        args: {
          description: 'Teste hint',
          amount: 100,
          type: 'expense',
          category: 'Salary',
          idempotencyKey: `test-hint-${stamp}`,
        },
      })) as { error?: { code?: string; hint?: string } };

      expect(result.error?.code).toBe('category_kind_mismatch');
      expect(result.error?.hint).toContain('set type: "income"');
    } finally {
      await transport.close();
    }
  });

  it('update_transaction clears the stale sub-category when switching to a plain category', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `ClearMe-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc.id, 'subCategory id missing');

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Lanche',
          amount: 15,
          type: 'expense',
          subCategory: `ClearMe-${stamp}`,
          idempotencyKey: `test-clear-subcat-${stamp}`,
        },
      })) as { transaction?: TransactionView };
      const tx = created.transaction ?? (created as TransactionView);
      ensure(tx.id, 'transaction id missing');
      createdTxIds.push(tx.id);
      expect(tx.subCategoryId).toBe(sc.id);

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: tx.id, category: 'Transport' },
      })) as TransactionView;

      expect(updated.categoryId).toBe('cat-transport');
      expect(updated.subCategoryId).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it('update_transaction keeps existing sub-category when category and subCategory are omitted', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `KeepMe-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc.id, 'subCategory id missing');

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Lanche',
          amount: 15,
          type: 'expense',
          subCategory: `KeepMe-${stamp}`,
          idempotencyKey: `test-keep-subcat-${stamp}`,
        },
      })) as { transaction?: TransactionView };
      const tx = created.transaction ?? (created as TransactionView);
      ensure(tx.id, 'transaction id missing');
      createdTxIds.push(tx.id);
      expect(tx.subCategoryId).toBe(sc.id);

      const updated = (await callTool(client, {
        name: 'update_transaction',
        args: { id: tx.id, amount: 20 },
      })) as TransactionView & { amount?: number };

      expect(updated.amount).toBe(20);
      expect(updated.subCategoryId).toBe(sc.id);
      expect(updated.categoryId).toBe('cat-food');
    } finally {
      await transport.close();
    }
  });

  it('list_categories excludes sub-categories (same table, parent_id set)', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const sc = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `LeakCheck-${stamp}`, parentId: 'cat-food' },
      })) as SubCategory;
      ensure(sc.id, 'subCategory id missing');

      const categories = (await callTool(client, { name: 'list_categories', args: {} })) as Array<{ id?: string }>;
      expect(categories.some((c) => c.id === sc.id)).toBe(false);
    } finally {
      await transport.close();
    }
  });

  it('create_sub_category rejects unknown parentId with structured error', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callToolError(client, {
        name: 'create_sub_category',
        args: { name: 'Anything', parentId: 'cat-does-not-exist' },
      })) as { error?: { code?: string; query?: string; candidates?: unknown[] } };

      expect(result.error?.code).toBe('unknown_category');
      expect(result.error?.query).toBe('cat-does-not-exist');
      expect(Array.isArray(result.error?.candidates)).toBe(true);
      expect((result.error?.candidates ?? []).length).toBeGreaterThan(0);
    } finally {
      await transport.close();
    }
  });

  it('update_transaction rejects setting a category on a transfer transaction', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const srcName = `TransferSrc-${stamp}`;
      const dstName = `TransferDst-${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: srcName, type: 'checking', currency: 'BRL', initialBalance: 500 },
      });
      await callTool(client, {
        name: 'create_account',
        args: { name: dstName, type: 'savings', currency: 'BRL', initialBalance: 0 },
      });

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: { from: srcName, to: dstName, amount: 100, idempotencyKey: `test-transfer-cat-${stamp}` },
      })) as { transaction?: TransactionView };
      const tx = transfer.transaction ?? (transfer as TransactionView);
      ensure(tx.id, 'transfer id missing');
      createdTxIds.push(tx.id);

      const result = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: tx.id, category: 'Food' },
      })) as { error?: { code?: string } };

      expect(result.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('update_transaction rejects kind mismatch when only category changes (no type provided)', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Despesa genérica',
          amount: 50,
          type: 'expense',
          idempotencyKey: `test-kind-update-${stamp}`,
        },
      })) as { transaction?: TransactionView };
      const tx = created.transaction ?? (created as TransactionView);
      ensure(tx.id, 'transaction id missing');
      createdTxIds.push(tx.id);

      const result = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: tx.id, category: 'Salary' },
      })) as { error?: { code?: string } };

      expect(result.error?.code).toBe('category_kind_mismatch');
    } finally {
      await transport.close();
    }
  });

  it('update_transaction rejects changing type of an existing transfer transaction', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const srcName = `TransferSrc2-${stamp}`;
      const dstName = `TransferDst2-${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: srcName, type: 'checking', currency: 'BRL', initialBalance: 500 },
      });
      await callTool(client, {
        name: 'create_account',
        args: { name: dstName, type: 'savings', currency: 'BRL', initialBalance: 0 },
      });

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: { from: srcName, to: dstName, amount: 50, idempotencyKey: `test-retype-transfer-${stamp}` },
      })) as { transaction?: TransactionView };
      const tx = transfer.transaction ?? (transfer as TransactionView);
      ensure(tx.id, 'transfer id missing');
      createdTxIds.push(tx.id);

      const result = (await callToolError(client, {
        name: 'update_transaction',
        args: { id: tx.id, type: 'expense' },
      })) as { error?: { code?: string } };

      expect(result.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('delete_sub_category blocked while referenced by a transaction, succeeds once cleared', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const accountName = `sub-del-acct-${stamp}`;
      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 0 },
      });

      const cat = (await callTool(client, {
        name: 'create_category',
        args: { name: `sub-parent-${stamp}`, kind: 'expense' },
      })) as { id: string; name: string };

      const sub = (await callTool(client, {
        name: 'create_sub_category',
        args: { name: `del-sub-${stamp}`, parentId: cat.id },
      })) as SubCategory;

      const txResult = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: `test-del-sub-${stamp}`,
          amount: 5,
          type: 'expense',
          date: '2026-01-16',
          account: accountName,
          subCategory: sub.name!,
          idempotencyKey: `del-sub-tx-${stamp}`,
        },
      })) as { transaction: { id: string } };
      createdTxIds.push(txResult.transaction.id);

      const { error } = (await callToolError(client, {
        name: 'delete_sub_category',
        args: { name: sub.name! },
      })) as ErrorPayload<InUseError>;
      expect(error.code).toBe('in_use');
      expect(error.entity).toBe('sub_category');
      expect(error.references.transactions).toBeGreaterThanOrEqual(1);

      await callTool(client, { name: 'delete_transaction', args: { id: txResult.transaction.id, confirm: true } });
      createdTxIds.splice(createdTxIds.indexOf(txResult.transaction.id), 1);

      const result = (await callTool(client, { name: 'delete_sub_category', args: { name: sub.name! } })) as {
        deleted: boolean;
      };
      expect(result.deleted).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('delete_sub_category returns unknown_sub_category for non-existent name', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const { error } = (await callToolError(client, {
        name: 'delete_sub_category',
        args: { name: 'nonexistent-sub-xyz-999' },
      })) as ErrorPayload<{ code: string }>;
      expect(error.code).toBe('unknown_sub_category');
    } finally {
      await transport.close();
    }
  });

  it('update_transaction rejects type: transfer at the wire boundary', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'create_transaction',
        args: {
          description: 'Despesa qualquer',
          amount: 20,
          type: 'expense',
          category: 'Food',
          idempotencyKey: `test-type-transfer-${stamp}`,
        },
      })) as { transaction?: TransactionView };
      const tx = created.transaction ?? (created as TransactionView);
      ensure(tx.id, 'transaction id missing');
      createdTxIds.push(tx.id);

      // type:'transfer' is not in MovementType (income|expense) — the MCP SDK rejects it
      // at the protocol level before the controller runs, so no JSON AppError is returned
      await expect(
        callTool(client, { name: 'update_transaction', args: { id: tx.id, type: 'transfer' } }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});
