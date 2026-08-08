import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, callToolError, deleteTransactions, ensure, makeClient } from './helpers.js';

type Budget = {
  id?: string;
  category?: string;
  subCategory?: string;
  currency?: string;
  limit?: number;
  period?: string;
};

type BudgetMeasure = { amount?: number; pct?: number };

type BudgetStatusLine = {
  id?: string;
  subCategory?: string;
  currency?: string;
  limit?: number;
  effective?: BudgetMeasure;
  committed?: BudgetMeasure;
  pending?: BudgetMeasure;
  remaining?: number;
};

type BudgetStatusGroup = { category?: string; lines?: BudgetStatusLine[] };
type BudgetStatus = { period?: { month?: number; year?: number }; categories?: BudgetStatusGroup[] };

const createdBudgetIds: string[] = [];
const createdTxIds: string[] = [];

afterEach(async () => {
  await deleteTransactions([...createdTxIds]);
  createdTxIds.length = 0;

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

/** A fixed date/period for every `get_budget_status` fixture below — always in the past, so it
 *  never drifts and never races the wall clock (a `new Date()`-derived "this month" computed once
 *  at module load can fall on the wrong side of a month boundary from a transaction whose own
 *  date-aware default resolves moments later). Every fixture transaction in that describe block
 *  passes `date: STATUS_DATE` explicitly rather than relying on "today". */
const STATUS_DATE = '2026-01-15';
const STATUS_PERIOD = { month: 1, year: 2026 };

/** add_account_expense returns `{ transaction, created, classification }` — this unwraps to just
 *  the id every fixture below needs, and registers it for the afterEach cleanup. */
const addExpense = async (client: Client, args: Record<string, unknown>): Promise<string> => {
  const result = (await callTool(client, { name: 'add_account_expense', args })) as {
    transaction?: { id?: string };
  };
  ensure(result.transaction?.id, 'add_account_expense: transaction id missing');
  createdTxIds.push(result.transaction.id);
  return result.transaction.id;
};

/** Same shape as `addExpense`, for `add_account_income` — used by the `both`-kind-category test,
 *  which needs both an expense and an income transaction on the same budgeted category. */
const addIncome = async (client: Client, args: Record<string, unknown>): Promise<string> => {
  const result = (await callTool(client, { name: 'add_account_income', args })) as {
    transaction?: { id?: string };
  };
  ensure(result.transaction?.id, 'add_account_income: transaction id missing');
  createdTxIds.push(result.transaction.id);
  return result.transaction.id;
};

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

describe('MCP integration > get_budget_status', () => {
  const findGroup = (status: BudgetStatus, category: string): BudgetStatusGroup | undefined =>
    status.categories?.find((g) => g.category === category);

  it('a category budget rolls up sub-category spend; a sub-category budget measures only its own', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Cat-${stamp}`;
    const subCategoryName = `Status-Sub-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const category = (await callTool(client, { name: 'create_category', args: { name: categoryName } })) as {
        id?: string;
      };
      ensure(category.id, 'category id missing');
      await callTool(client, { name: 'create_sub_category', args: { name: subCategoryName, parentId: category.id } });

      const categoryBudget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 1000 },
      })) as Budget;
      ensure(categoryBudget.id, 'category budget id missing');
      createdBudgetIds.push(categoryBudget.id);

      const subBudget = (await callTool(client, {
        name: 'create_budget',
        args: { subCategory: subCategoryName, currency: 'BRL', limit: 200 },
      })) as Budget;
      ensure(subBudget.id, 'sub-category budget id missing');
      createdBudgetIds.push(subBudget.id);

      await addExpense(client, {
        description: 'direct category spend',
        amount: 300,
        category: categoryName,
        currency: 'BRL',
        date: STATUS_DATE,
        idempotencyKey: `status-direct-${stamp}`,
      });

      await addExpense(client, {
        description: 'sub-category spend',
        amount: 150,
        subCategory: subCategoryName,
        currency: 'BRL',
        date: STATUS_DATE,
        idempotencyKey: `status-sub-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);

      const categoryLine = group.lines?.find((l) => l.subCategory === undefined);
      const subLine = group.lines?.find((l) => l.subCategory === subCategoryName);
      // rollup: 300 + 150
      expect(categoryLine).toMatchObject({ effective: { amount: 450 }, committed: { amount: 450 }, remaining: 550 });
      // its own spend only, not 450
      expect(subLine).toMatchObject({ effective: { amount: 150 }, committed: { amount: 150 }, remaining: 50 });
    } finally {
      await transport.close();
    }
  });

  it('isolates spend per currency — a BRL budget ignores a USD expense in the same category', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Currency-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      await addExpense(client, {
        description: 'USD spend, should not count toward the BRL budget',
        amount: 999,
        category: categoryName,
        currency: 'USD',
        date: STATUS_DATE,
        idempotencyKey: `status-usd-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      expect(group.lines?.[0]).toMatchObject({
        currency: 'BRL',
        effective: { amount: 0 },
        committed: { amount: 0 },
        remaining: 500,
      });
    } finally {
      await transport.close();
    }
  });

  it('excludes pending from effective but includes it in committed (FD-020)', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Pending-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      await addExpense(client, {
        description: 'pending spend — excluded from effective, counted in committed',
        amount: 400,
        category: categoryName,
        currency: 'BRL',
        status: 'pending',
        date: STATUS_DATE,
        idempotencyKey: `status-pending-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 0, pct: 0 },
        committed: { amount: 400, pct: 0.8 },
        pending: { amount: 400, pct: 0.8 },
        remaining: 100,
      });
    } finally {
      await transport.close();
    }
  });

  it('mixes effective and pending on the same target: committed sums both, effective stays cleared-only', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Mixed-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      await addExpense(client, {
        description: 'cleared spend',
        amount: 150,
        category: categoryName,
        currency: 'BRL',
        status: 'effective',
        date: STATUS_DATE,
        idempotencyKey: `status-mixed-effective-${stamp}`,
      });
      await addExpense(client, {
        description: 'earmarked, not yet cleared',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        status: 'pending',
        date: STATUS_DATE,
        idempotencyKey: `status-mixed-pending-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 150, pct: 0.3 },
        committed: { amount: 250, pct: 0.5 },
        pending: { amount: 100, pct: 0.2 },
        remaining: 250,
      });
    } finally {
      await transport.close();
    }
  });

  it('a future-dated expense with no explicit status defaults to pending, counted only in committed', async () => {
    const stamp = Date.now();
    const categoryName = `Status-FutureDefault-${stamp}`;
    // Always ahead of "today" — a future date with no explicit status defaults to pending (invariant 20).
    const futureDate = '2099-06-15';
    const futurePeriod = { month: 6, year: 2099 };
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      await addExpense(client, {
        description: 'future-dated, status omitted — defaults to pending',
        amount: 200,
        category: categoryName,
        currency: 'BRL',
        date: futureDate,
        idempotencyKey: `status-future-default-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: futurePeriod })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 0 },
        committed: { amount: 200 },
        pending: { amount: 200 },
        remaining: 300,
      });
    } finally {
      await transport.close();
    }
  });

  it('excludes transfers from spend, same predicate every other summary/aggregate query uses', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Transfer-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      const fromAccount = (await callTool(client, {
        name: 'create_account',
        args: { name: `Transfer-From-${stamp}`, type: 'checking', currency: 'BRL' },
      })) as { id?: string; name?: string };
      const toAccount = (await callTool(client, {
        name: 'create_account',
        args: { name: `Transfer-To-${stamp}`, type: 'checking', currency: 'BRL' },
      })) as { id?: string; name?: string };
      ensure(fromAccount.name, 'from account name missing');
      ensure(toAccount.name, 'to account name missing');

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: {
          from: fromAccount.name,
          to: toAccount.name,
          amount: 1000,
          date: STATUS_DATE,
          idempotencyKey: `status-transfer-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(transfer.transaction?.id, 'transfer transaction id missing');
      createdTxIds.push(transfer.transaction.id);

      // Direct expense in the budgeted category, unaffected by the unrelated transfer above.
      await addExpense(client, {
        description: 'unrelated category spend',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        date: STATUS_DATE,
        idempotencyKey: `status-transfer-spend-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      // A transfer carries no category, so it can never match a budget's category/subcategory —
      // this asserts spend isn't inflated by the transfer's amount regardless (e.g. via a join bug),
      // on either measure.
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 100 },
        committed: { amount: 100 },
        remaining: 400,
      });
    } finally {
      await transport.close();
    }
  });

  it('excludes income from spend on a both-kind category — never inflates the cap, on either measure', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: 'Investments', currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      await addIncome(client, {
        description: 'dividend received, should not count as spend',
        amount: 2000,
        category: 'Investments',
        currency: 'BRL',
        date: STATUS_DATE,
        idempotencyKey: `status-investment-income-${stamp}`,
      });
      await addIncome(client, {
        description: 'pending dividend, should not count as spend either',
        amount: 3000,
        category: 'Investments',
        currency: 'BRL',
        status: 'pending',
        date: STATUS_DATE,
        idempotencyKey: `status-investment-income-pending-${stamp}`,
      });

      await addExpense(client, {
        description: 'money moved into the investment, the actual spend',
        amount: 100,
        category: 'Investments',
        currency: 'BRL',
        date: STATUS_DATE,
        idempotencyKey: `status-investment-expense-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, 'Investments');
      ensure(group, 'no status group for Investments');
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 100 },
        committed: { amount: 100 },
        remaining: 400,
      });
    } finally {
      await transport.close();
    }
  });

  it('reports over-budget as negative remaining and pct > 1, never an error', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Over-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 100 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      await addExpense(client, {
        description: 'over budget spend',
        amount: 250,
        category: categoryName,
        currency: 'BRL',
        date: STATUS_DATE,
        idempotencyKey: `status-over-${stamp}`,
      });

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 250, pct: 2.5 },
        committed: { amount: 250, pct: 2.5 },
        remaining: -150,
      });
    } finally {
      await transport.close();
    }
  });

  it('reports amount: 0 on every measure for a budget with no matching transactions this period', async () => {
    const stamp = Date.now();
    const categoryName = `Status-Empty-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const budget = (await callTool(client, {
        name: 'create_budget',
        args: { category: categoryName, currency: 'BRL', limit: 500 },
      })) as Budget;
      ensure(budget.id, 'budget id missing');
      createdBudgetIds.push(budget.id);

      const status = (await callTool(client, { name: 'get_budget_status', args: STATUS_PERIOD })) as BudgetStatus;
      const group = findGroup(status, categoryName);
      ensure(group, `no status group for ${categoryName}`);
      expect(group.lines?.[0]).toMatchObject({
        effective: { amount: 0, pct: 0 },
        committed: { amount: 0, pct: 0 },
        pending: { amount: 0, pct: 0 },
        remaining: 500,
      });
    } finally {
      await transport.close();
    }
  });
});
