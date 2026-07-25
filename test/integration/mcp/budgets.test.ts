import { afterEach, describe, expect, it } from 'vitest';
import { callTool, callToolError, ensure, makeClient } from './helpers.js';

type Budget = {
  id?: string;
  category?: string;
  subCategory?: string;
  currency?: string;
  limit?: number;
  period?: string;
};

const createdBudgetIds: string[] = [];

afterEach(async () => {
  if (!createdBudgetIds.length) return;
  const { client, transport } = makeClient();
  try {
    await client.connect(transport);
    for (const id of [...createdBudgetIds]) {
      try {
        await callTool(client, { name: 'delete_budget', args: { id } });
      } catch {
        // best-effort
      }
    }
  } finally {
    await transport.close();
    createdBudgetIds.length = 0;
  }
});

describe('MCP integration > budgets', () => {
  it('create_budget on a top-level category returns the resolved category and limit', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: 'Food', currency: 'USD', limit: 500 },
      })) as Budget;

      ensure(budget.id, 'Budget id missing');
      expect(budget.category).toBe('Food');
      expect(budget.subCategory).toBeUndefined();
      expect(budget.currency).toBe('USD');
      expect(budget.limit).toBe(500);
      expect(budget.period).toBe('monthly');
      createdBudgetIds.push(budget.id);
    } finally {
      await transport.close();
    }
  });

  it('create_budget on a sub-category rolls up under its parent category name', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const subCategoryName = `Restaurants-${stamp}`;
      await callTool(client, { name: 'create_sub_category', args: { name: subCategoryName, parentId: 'cat-food' } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { subCategory: subCategoryName, currency: 'USD', limit: 150 },
      })) as Budget;

      ensure(budget.id, 'Budget id missing');
      expect(budget.category).toBe('Food');
      expect(budget.subCategory).toBe(subCategoryName);
      createdBudgetIds.push(budget.id);
    } finally {
      await transport.close();
    }
  });

  it('create_budget rejects a duplicate (target, currency, period)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: 'Transport', currency: 'USD', limit: 300 },
      })) as Budget;
      ensure(budget.id, 'Budget id missing');
      createdBudgetIds.push(budget.id);

      const error = (await callToolError(client, {
        name: 'create_budget',
        args: { category: 'Transport', currency: 'USD', limit: 999 },
      })) as { error?: { code?: string } };
      expect(error.error?.code).toBe('duplicate_budget');
    } finally {
      await transport.close();
    }
  });

  it('create_budget rejects an income-kind category', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const error = (await callToolError(client, {
        name: 'create_budget',
        args: { category: 'Salary', currency: 'USD', limit: 500 },
      })) as { error?: { code?: string } };
      expect(error.error?.code).toBe('not_expense_category');
    } finally {
      await transport.close();
    }
  });

  it('create_budget rejects when neither category nor subCategory is given', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const error = (await callToolError(client, {
        name: 'create_budget',
        args: { currency: 'USD', limit: 500 },
      })) as { error?: { code?: string } };
      expect(error.error?.code).toBe('validation');
    } finally {
      await transport.close();
    }
  });

  it('create_budget rejects an unknown category name', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const error = (await callToolError(client, {
        name: 'create_budget',
        args: { category: 'Does Not Exist At All', currency: 'USD', limit: 500 },
      })) as { error?: { code?: string } };
      expect(error.error?.code).toBe('unknown_category');
    } finally {
      await transport.close();
    }
  });

  it('create_budget is race-safe: concurrent creates for the same target yield exactly one budget', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const results = await Promise.allSettled([
        callTool(client, { name: 'create_budget', args: { category: 'Health', currency: 'USD', limit: 200 } }),
        callTool(client, { name: 'create_budget', args: { category: 'Health', currency: 'USD', limit: 200 } }),
      ]);

      const succeeded = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<unknown>[];
      expect(succeeded.length).toBe(1);
      const budget = succeeded[0]!.value as Budget;
      ensure(budget.id, 'Budget id missing');
      createdBudgetIds.push(budget.id);

      const budgets = (await callTool(client, { name: 'list_budgets', args: {} })) as Budget[];
      expect(budgets.filter((b) => b.category === 'Health' && b.currency === 'USD').length).toBe(1);
    } finally {
      await transport.close();
    }
  });

  it('list_budgets includes the created budget', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: 'Leisure', currency: 'USD', limit: 100 },
      })) as Budget;
      ensure(budget.id, 'Budget id missing');
      createdBudgetIds.push(budget.id);

      const budgets = (await callTool(client, { name: 'list_budgets', args: {} })) as Budget[];
      expect(budgets.some((b) => b.id === budget.id)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it('update_budget changes the limit', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: 'Shopping', currency: 'USD', limit: 100 },
      })) as Budget;
      ensure(budget.id, 'Budget id missing');
      createdBudgetIds.push(budget.id);

      const updated = (await callTool(client, {
        name: 'update_budget',
        args: { id: budget.id, limit: 250 },
      })) as Budget;
      expect(updated.limit).toBe(250);
      expect(updated.category).toBe('Shopping');
    } finally {
      await transport.close();
    }
  });

  it('update_budget reports unknown_budget for a missing id', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const error = (await callToolError(client, {
        name: 'update_budget',
        args: { id: 'budget-does-not-exist', limit: 250 },
      })) as { error?: { code?: string } };
      expect(error.error?.code).toBe('unknown_budget');
    } finally {
      await transport.close();
    }
  });

  it('delete_budget removes the budget and it no longer appears in list', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: 'Education', currency: 'USD', limit: 100 },
      })) as Budget;
      ensure(budget.id, 'Budget id missing');
      const budgetId = budget.id;

      const result = (await callTool(client, { name: 'delete_budget', args: { id: budgetId } })) as {
        deleted?: boolean;
      };
      expect(result.deleted).toBe(true);

      const budgets = (await callTool(client, { name: 'list_budgets', args: {} })) as Budget[];
      expect(budgets.some((b) => b.id === budgetId)).toBe(false);
      // already deleted — no need to clean up
    } finally {
      await transport.close();
    }
  });

  it('delete_budget returns deleted:false for a non-existent id', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'delete_budget',
        args: { id: 'budget-does-not-exist' },
      })) as { deleted?: boolean };
      expect(result.deleted).toBe(false);
    } finally {
      await transport.close();
    }
  });
});
