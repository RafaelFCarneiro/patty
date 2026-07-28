import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { callTool, deleteTransactions, ensure, makeClient } from './helpers.js';

type SpendingShift = {
  category?: string;
  currency?: string;
  current?: number;
  baseline?: number;
  deltaPct?: number | null;
  direction?: string;
};

type BudgetFitLine = {
  id?: string;
  category?: string;
  subCategory?: string;
  currency?: string;
  limit?: number;
  current?: number;
  baseline?: number;
  verdict?: string;
  suggestedLimit?: number;
};

type UnbudgetedSpend = { category?: string; currency?: string; baseline?: number; suggestedLimit?: number };

type FindCorrelationsResult = {
  analysis?: string;
  month?: number;
  year?: number;
  shifts?: SpendingShift[];
  budgeted?: BudgetFitLine[];
  unbudgeted?: UnbudgetedSpend[];
};

// A fixed reference period and its trailing 3-month baseline window, always in the past so this
// never drifts or races the wall clock — mirrors budgets.test.ts's STATUS_DATE/STATUS_PERIOD.
const REFERENCE = { month: 6, year: 2025 };
const CURRENT_DATE = '2025-06-15';
const BASELINE_DATES = ['2025-03-15', '2025-04-15', '2025-05-15'];
const EMPTY_PERIOD = { month: 1, year: 2011 };

const createdTxIds: string[] = [];
const createdBudgetIds: string[] = [];

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

const addExpense = async (client: Client, args: Record<string, unknown>): Promise<string> => {
  const result = (await callTool(client, { name: 'add_account_expense', args })) as {
    transaction?: { id?: string };
  };
  ensure(result.transaction?.id, 'add_account_expense: transaction id missing');
  createdTxIds.push(result.transaction.id);
  return result.transaction.id;
};

const addIncome = async (client: Client, args: Record<string, unknown>): Promise<string> => {
  const result = (await callTool(client, { name: 'add_account_income', args })) as {
    transaction?: { id?: string };
  };
  ensure(result.transaction?.id, 'add_account_income: transaction id missing');
  createdTxIds.push(result.transaction.id);
  return result.transaction.id;
};

/** Three equal baseline-window expenses (one per month in `BASELINE_DATES`) so the resulting
 *  `baseline` is easy to predict: `monthlyAmount` (a flat trailing average, no need to divide). */
const seedBaseline = async (
  client: Client,
  category: string,
  monthlyAmount: number,
  currency: string,
  stamp: number,
): Promise<void> => {
  for (const [i, date] of BASELINE_DATES.entries()) {
    await addExpense(client, {
      description: `baseline ${category}`,
      amount: monthlyAmount,
      category,
      currency,
      date,
      idempotencyKey: `corr-baseline-${stamp}-${category}-${currency}-${i}`,
    });
  }
};

const createBudget = async (client: Client, args: Record<string, unknown>): Promise<string> => {
  const budget = (await callTool(client, { name: 'create_budget', args })) as { id?: string };
  ensure(budget.id, 'create_budget: id missing');
  createdBudgetIds.push(budget.id);
  return budget.id;
};

const findShift = (result: FindCorrelationsResult, category: string, currency = 'BRL'): SpendingShift | undefined =>
  result.shifts?.find((s) => s.category === category && s.currency === currency);

const findBudgetedLine = (
  result: FindCorrelationsResult,
  category: string,
  currency = 'BRL',
): BudgetFitLine | undefined => result.budgeted?.find((b) => b.category === category && b.currency === currency);

const findUnbudgeted = (
  result: FindCorrelationsResult,
  category: string,
  currency = 'BRL',
): UnbudgetedSpend | undefined => result.unbudgeted?.find((u) => u.category === category && u.currency === currency);

describe('MCP integration > find_correlations (spending_shifts)', () => {
  it('reports an up shift with the correct current/baseline/deltaPct beyond minDeltaPct', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Up-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp);
      await addExpense(client, {
        description: 'reference month spend',
        amount: 250,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-current-${stamp}`,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE },
      })) as FindCorrelationsResult;

      expect(result.analysis).toBe('spending_shifts');
      const shift = findShift(result, categoryName);
      ensure(shift, `no shift for ${categoryName}`);
      // baseline = (100+100+100)/3 = 100; deltaPct = (250-100)/100*100 = 150
      expect(shift).toMatchObject({ current: 250, baseline: 100, deltaPct: 150, direction: 'up' });
    } finally {
      await transport.close();
    }
  });

  it('reports a brand-new category (no baseline spend at all) as deltaPct: null, direction: up', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-New-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'first ever spend',
        amount: 80,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-newcat-${stamp}`,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 200 },
      })) as FindCorrelationsResult;

      const shift = findShift(result, categoryName);
      ensure(shift, `no shift for ${categoryName}`);
      // Always surfaced regardless of minDeltaPct — there's no percentage to threshold against.
      expect(shift).toMatchObject({ current: 80, baseline: 0, deltaPct: null, direction: 'up' });
    } finally {
      await transport.close();
    }
  });

  it('reports a dropped category (baseline spend, nothing this month) as direction: down', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dropped-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp);

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE },
      })) as FindCorrelationsResult;

      const shift = findShift(result, categoryName);
      ensure(shift, `no shift for ${categoryName}`);
      expect(shift).toMatchObject({ current: 0, baseline: 100, deltaPct: -100, direction: 'down' });
    } finally {
      await transport.close();
    }
  });

  it('isolates shifts per currency — BRL and USD spend in the same category never mix', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Currency-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp);
      await seedBaseline(client, categoryName, 50, 'USD', stamp);
      await addExpense(client, {
        description: 'BRL current',
        amount: 200,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-cur-brl-${stamp}`,
      });
      await addExpense(client, {
        description: 'USD current',
        amount: 50,
        category: categoryName,
        currency: 'USD',
        date: CURRENT_DATE,
        idempotencyKey: `corr-cur-usd-${stamp}`,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 0 },
      })) as FindCorrelationsResult;

      const brl = findShift(result, categoryName, 'BRL');
      const usd = findShift(result, categoryName, 'USD');
      ensure(brl, `no BRL shift for ${categoryName}`);
      ensure(usd, `no USD shift for ${categoryName}`);
      expect(brl).toMatchObject({ current: 200, baseline: 100, deltaPct: 100 });
      expect(usd).toMatchObject({ current: 50, baseline: 50, deltaPct: 0 });
    } finally {
      await transport.close();
    }
  });

  it('excludes pending transactions from current — only effective spend counts', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Pending-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'effective spend',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-pending-eff-${stamp}`,
      });
      await addExpense(client, {
        description: 'pending spend, should not count',
        amount: 500,
        category: categoryName,
        currency: 'BRL',
        status: 'pending',
        date: CURRENT_DATE,
        idempotencyKey: `corr-pending-pnd-${stamp}`,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 0 },
      })) as FindCorrelationsResult;

      const shift = findShift(result, categoryName);
      ensure(shift, `no shift for ${categoryName}`);
      expect(shift.current).toBe(100);
    } finally {
      await transport.close();
    }
  });

  it('excludes transfers from current, same predicate every other summary/aggregate query uses', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Transfer-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });

      const fromAccount = (await callTool(client, {
        name: 'create_account',
        args: { name: `Corr-Transfer-From-${stamp}`, type: 'checking', currency: 'BRL' },
      })) as { name?: string };
      const toAccount = (await callTool(client, {
        name: 'create_account',
        args: { name: `Corr-Transfer-To-${stamp}`, type: 'checking', currency: 'BRL' },
      })) as { name?: string };
      ensure(fromAccount.name, 'from account name missing');
      ensure(toAccount.name, 'to account name missing');

      const transfer = (await callTool(client, {
        name: 'create_transfer',
        args: {
          from: fromAccount.name,
          to: toAccount.name,
          amount: 1000,
          date: CURRENT_DATE,
          idempotencyKey: `corr-transfer-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      ensure(transfer.transaction?.id, 'transfer transaction id missing');
      createdTxIds.push(transfer.transaction.id);

      // A transfer carries no category, so it can never join to this one — regression guard
      // against a future join/filter bug, mirroring budgets.test.ts's own transfer-exclusion test.
      await addExpense(client, {
        description: 'unrelated category spend',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-transfer-spend-${stamp}`,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 0 },
      })) as FindCorrelationsResult;

      const shift = findShift(result, categoryName);
      ensure(shift, `no shift for ${categoryName}`);
      expect(shift.current).toBe(100);
    } finally {
      await transport.close();
    }
  });

  it('excludes income from current on a both-kind category — a spend shift is never inflated by income', async () => {
    const stamp = Date.now();
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await addIncome(client, {
        description: 'dividend received, should not count',
        amount: 2000,
        category: 'Investments',
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-invest-income-${stamp}`,
      });
      await addExpense(client, {
        description: 'money moved into the investment, the actual spend',
        amount: 150,
        category: 'Investments',
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-invest-expense-${stamp}`,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 0 },
      })) as FindCorrelationsResult;

      const shift = findShift(result, 'Investments');
      ensure(shift, 'no shift for Investments');
      expect(shift.current).toBe(150);
    } finally {
      await transport.close();
    }
  });

  it('filters out shifts below minDeltaPct but always surfaces brand-new categories', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BelowThreshold-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp);
      await addExpense(client, {
        description: 'small bump, below the default 20% threshold',
        amount: 105,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
        idempotencyKey: `corr-small-${stamp}`,
      });

      const filtered = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE },
      })) as FindCorrelationsResult;
      expect(findShift(filtered, categoryName)).toBeUndefined();

      const unfiltered = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 0 },
      })) as FindCorrelationsResult;
      expect(findShift(unfiltered, categoryName)).toMatchObject({ current: 105, baseline: 100 });
    } finally {
      await transport.close();
    }
  });

  it('returns an empty shifts array for a reference month with no matching transactions', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...EMPTY_PERIOD },
      })) as FindCorrelationsResult;
      expect(result.shifts).toEqual([]);
    } finally {
      await transport.close();
    }
  });
});

describe('MCP integration > find_correlations (budget_fit)', () => {
  it('reports unrealistic with a suggestedLimit above baseline for a materially over-budget category', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BudgetOver-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp); // baseline 100/mo
      await createBudget(client, { category: categoryName, currency: 'BRL', limit: 50 }); // ratio 2.0

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;

      expect(result.analysis).toBe('budget_fit');
      const line = findBudgetedLine(result, categoryName);
      ensure(line, `no budgeted line for ${categoryName}`);
      expect(line).toMatchObject({ limit: 50, baseline: 100, verdict: 'unrealistic', suggestedLimit: 110 });
    } finally {
      await transport.close();
    }
  });

  it('reports generous for a well-under-budget category', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BudgetGenerous-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp); // baseline 100/mo
      await createBudget(client, { category: categoryName, currency: 'BRL', limit: 1000 }); // ratio 0.1

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;

      const line = findBudgetedLine(result, categoryName);
      ensure(line, `no budgeted line for ${categoryName}`);
      expect(line.verdict).toBe('generous');
    } finally {
      await transport.close();
    }
  });

  it('surfaces a category with an established baseline and no budget as unbudgeted', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BudgetMissing-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp);

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;

      expect(findBudgetedLine(result, categoryName)).toBeUndefined();
      const unbudgeted = findUnbudgeted(result, categoryName);
      ensure(unbudgeted, `no unbudgeted entry for ${categoryName}`);
      expect(unbudgeted).toMatchObject({ baseline: 100, suggestedLimit: 110 });
    } finally {
      await transport.close();
    }
  });

  it('isolates a budget verdict per currency — a BRL budget ignores USD spend in the same category', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BudgetCurrency-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 100, 'BRL', stamp); // BRL baseline 100/mo
      await seedBaseline(client, categoryName, 5000, 'USD', stamp); // unrelated, much larger USD baseline
      await createBudget(client, { category: categoryName, currency: 'BRL', limit: 110 }); // ratio ~0.91, realistic

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;

      const line = findBudgetedLine(result, categoryName, 'BRL');
      ensure(line, `no BRL budgeted line for ${categoryName}`);
      // If the USD spend leaked in, baseline would be ~1700 instead of 100 and the verdict would flip.
      expect(line).toMatchObject({ currency: 'BRL', baseline: 100, verdict: 'realistic' });
    } finally {
      await transport.close();
    }
  });

  it('reports current: 0 for a budget whose category has no spend, without erroring', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BudgetEmpty-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await createBudget(client, { category: categoryName, currency: 'BRL', limit: 300 });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;

      const line = findBudgetedLine(result, categoryName);
      ensure(line, `no budgeted line for ${categoryName}`);
      expect(line).toMatchObject({ current: 0, baseline: 0, verdict: 'generous' });
    } finally {
      await transport.close();
    }
  });

  it('reports a sub-category budget under its parent category name', async () => {
    const stamp = Date.now();
    const parentName = `Corr-BudgetParent-${stamp}`;
    const subCategoryName = `Corr-BudgetSub-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const parent = (await callTool(client, { name: 'create_category', args: { name: parentName } })) as {
        id?: string;
      };
      ensure(parent.id, 'parent category id missing');
      await callTool(client, { name: 'create_sub_category', args: { name: subCategoryName, parentId: parent.id } });
      // seedBaseline targets `category`, which resolves the top-level node — a sub-category budget
      // needs spend against `subCategory` specifically, so this seeds it directly instead.
      for (const [i, date] of BASELINE_DATES.entries()) {
        await addExpense(client, {
          description: `baseline ${subCategoryName}`,
          amount: 100,
          subCategory: subCategoryName,
          currency: 'BRL',
          date,
          idempotencyKey: `corr-budget-sub-baseline-${stamp}-${i}`,
        });
      }
      await createBudget(client, { subCategory: subCategoryName, currency: 'BRL', limit: 50 });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;

      const line = result.budgeted?.find((b) => b.subCategory === subCategoryName);
      ensure(line, `no budgeted line for sub-category ${subCategoryName}`);
      expect(line).toMatchObject({ category: parentName, baseline: 100, verdict: 'unrealistic' });
      // The sub-category's spend rolls up to the parent too, but it's already covered by this
      // budget, so the parent must not also show up as a separate "unbudgeted" suggestion.
      expect(findUnbudgeted(result, parentName)).toBeUndefined();
    } finally {
      await transport.close();
    }
  });
});
