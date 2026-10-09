import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
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

type MerchantShare = { merchant?: string; spent?: number; share?: number; cumulativeShare?: number };

type CategoryConcentration = {
  category?: string;
  currency?: string;
  categoryTotal?: number;
  merchants?: MerchantShare[];
  othersSpent?: number;
};

type RecurringCandidate = {
  merchant?: string;
  typicalAmount?: number;
  currency?: string;
  category?: string;
  occurrences?: number;
  lastDate?: string;
  suggestedNextDue?: string;
};

type ConvertedTotal = {
  displayCurrency?: string;
  total?: number;
  stale?: boolean;
  asOf?: string | null;
  excluded?: Array<{ currency?: string; reason?: string }>;
};

type FindCorrelationsResult = {
  analysis?: string;
  month?: number;
  year?: number;
  shifts?: SpendingShift[];
  budgeted?: BudgetFitLine[];
  unbudgeted?: UnbudgetedSpend[];
  categories?: CategoryConcentration[];
  candidates?: RecurringCandidate[];
  converted?: ConvertedTotal;
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
): Promise<void> => {
  for (const [, date] of BASELINE_DATES.entries()) {
    await addExpense(client, {
      description: `baseline ${category}`,
      amount: monthlyAmount,
      category,
      currency,
      date,
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
      await seedBaseline(client, categoryName, 100, 'BRL');
      await addExpense(client, {
        description: 'reference month spend',
        amount: 250,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
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
      await seedBaseline(client, categoryName, 100, 'BRL');

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
      await seedBaseline(client, categoryName, 100, 'BRL');
      await seedBaseline(client, categoryName, 50, 'USD');
      await addExpense(client, {
        description: 'BRL current',
        amount: 200,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });
      await addExpense(client, {
        description: 'USD current',
        amount: 50,
        category: categoryName,
        currency: 'USD',
        date: CURRENT_DATE,
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
      });
      await addExpense(client, {
        description: 'pending spend, should not count',
        amount: 500,
        category: categoryName,
        currency: 'BRL',
        status: 'pending',
        date: CURRENT_DATE,
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
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await addIncome(client, {
        description: 'dividend received, should not count',
        amount: 2000,
        category: 'Investments',
        currency: 'BRL',
        date: CURRENT_DATE,
      });
      await addExpense(client, {
        description: 'money moved into the investment, the actual spend',
        amount: 150,
        category: 'Investments',
        currency: 'BRL',
        date: CURRENT_DATE,
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
      await seedBaseline(client, categoryName, 100, 'BRL');
      await addExpense(client, {
        description: 'small bump, below the default 20% threshold',
        amount: 105,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
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

  it('preserves BTC current/baseline precision to 8dp, not flattened to fiat-shaped 2dp', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-BTC-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await seedBaseline(client, categoryName, 0.12345678, 'BTC');
      await addExpense(client, {
        description: 'BTC current spend',
        amount: 0.87654321,
        category: categoryName,
        currency: 'BTC',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, minDeltaPct: 0 },
      })) as FindCorrelationsResult;

      const shift = findShift(result, categoryName, 'BTC');
      ensure(shift, `no BTC shift for ${categoryName}`);
      expect(shift).toMatchObject({ current: 0.87654321, baseline: 0.12345678 });
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
      await seedBaseline(client, categoryName, 100, 'BRL'); // baseline 100/mo
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
      await seedBaseline(client, categoryName, 100, 'BRL'); // baseline 100/mo
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
      await seedBaseline(client, categoryName, 100, 'BRL');

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
      await seedBaseline(client, categoryName, 100, 'BRL'); // BRL baseline 100/mo
      await seedBaseline(client, categoryName, 5000, 'USD'); // unrelated, much larger USD baseline
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
      for (const [, date] of BASELINE_DATES.entries()) {
        await addExpense(client, {
          description: `baseline ${subCategoryName}`,
          amount: 100,
          subCategory: subCategoryName,
          currency: 'BRL',
          date,
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

describe('MCP integration > find_correlations (merchant_concentration)', () => {
  const findConcentration = (result: FindCorrelationsResult, category: string, currency = 'BRL') =>
    result.categories?.find((c) => c.category === category && c.currency === currency);

  it('reports 100% share and zero othersSpent for a single-merchant category', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Concentration-Single-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'Uber',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE },
      })) as FindCorrelationsResult;

      expect(result.analysis).toBe('merchant_concentration');
      const group = findConcentration(result, categoryName);
      ensure(group, `no concentration group for ${categoryName}`);
      expect(group).toEqual({
        category: categoryName,
        currency: 'BRL',
        categoryTotal: 100,
        merchants: [{ merchant: 'uber', spent: 100, share: 1, cumulativeShare: 1 }],
        othersSpent: 0,
      });
    } finally {
      await transport.close();
    }
  });

  it('cuts off at topN and rolls the remainder into othersSpent, shares still summing to 1', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Concentration-TopN-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      const merchants: [string, number][] = [
        ['Uber', 300],
        ['Ifood', 200],
        ['Amazon', 100],
      ];
      for (const [, [description, amount]] of merchants.entries()) {
        await addExpense(client, {
          description,
          amount,
          category: categoryName,
          currency: 'BRL',
          date: CURRENT_DATE,
        });
      }

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE, topN: 2 },
      })) as FindCorrelationsResult;

      const group = findConcentration(result, categoryName);
      ensure(group, `no concentration group for ${categoryName}`);
      expect(group.categoryTotal).toBe(600);
      expect(group.merchants?.map((m) => m.merchant)).toEqual(['uber', 'ifood']);
      expect(group.othersSpent).toBe(100);

      const shareSum = (group.merchants ?? []).reduce((sum, m) => sum + (m.share ?? 0), 0);
      expect(shareSum + group.othersSpent! / group.categoryTotal!).toBeCloseTo(1, 4);
    } finally {
      await transport.close();
    }
  });

  it('isolates concentration per currency — a BRL expense never joins the USD group', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Concentration-Currency-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'Uber',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });
      await addExpense(client, {
        description: 'Uber',
        amount: 40,
        category: categoryName,
        currency: 'USD',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE },
      })) as FindCorrelationsResult;

      const brl = findConcentration(result, categoryName, 'BRL');
      const usd = findConcentration(result, categoryName, 'USD');
      ensure(brl, `no BRL group for ${categoryName}`);
      ensure(usd, `no USD group for ${categoryName}`);
      expect(brl.categoryTotal).toBe(100);
      expect(usd.categoryTotal).toBe(40);
    } finally {
      await transport.close();
    }
  });

  it('excludes pending transactions — only effective spend counts', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Concentration-Pending-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'Uber',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });
      await addExpense(client, {
        description: 'Amazon',
        amount: 500,
        category: categoryName,
        currency: 'BRL',
        status: 'pending',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE },
      })) as FindCorrelationsResult;

      const group = findConcentration(result, categoryName);
      ensure(group, `no concentration group for ${categoryName}`);
      expect(group.categoryTotal).toBe(100);
    } finally {
      await transport.close();
    }
  });

  it('restricts to the requested category when the category filter is given', async () => {
    const stamp = Date.now();
    const wantedCategory = `Corr-Concentration-Wanted-${stamp}`;
    const otherCategory = `Corr-Concentration-Other-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: wantedCategory } });
      await callTool(client, { name: 'create_category', args: { name: otherCategory } });
      await addExpense(client, {
        description: 'Uber',
        amount: 100,
        category: wantedCategory,
        currency: 'BRL',
        date: CURRENT_DATE,
      });
      await addExpense(client, {
        description: 'Amazon',
        amount: 200,
        category: otherCategory,
        currency: 'BRL',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE, category: wantedCategory },
      })) as FindCorrelationsResult;

      expect(result.categories?.map((c) => c.category)).toEqual([wantedCategory]);
    } finally {
      await transport.close();
    }
  });

  it('returns an empty categories array for a period with no matching transactions', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...EMPTY_PERIOD },
      })) as FindCorrelationsResult;
      expect(result.categories).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it('preserves USDC spent/categoryTotal precision to 6dp, not flattened to fiat-shaped 2dp', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Concentration-USDC-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'USDC payment',
        amount: 123.123456,
        category: categoryName,
        currency: 'USDC',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE },
      })) as FindCorrelationsResult;

      const group = findConcentration(result, categoryName, 'USDC');
      ensure(group, `no USDC group for ${categoryName}`);
      expect(group.categoryTotal).toBe(123.123456);
    } finally {
      await transport.close();
    }
  });
});

describe('MCP integration > find_correlations (recurring_candidates)', () => {
  // Unlike REFERENCE/CURRENT_DATE above — this mode has no reference period, only a live window.
  const daysAgo = (n: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return toIsoDate(d);
  };

  const findCandidate = (result: FindCorrelationsResult, merchant: string): RecurringCandidate | undefined =>
    result.candidates?.find((c) => c.merchant === merchant);

  it('flags a merchant with a consistent ~monthly cadence and stable amount, shaped for create_recurring', async () => {
    const merchant = 'Corr Candidate Streaming';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      for (const [, offset] of [90, 60, 30, 0].entries()) {
        await addExpense(client, {
          description: merchant,
          amount: 39.9,
          category: 'Subscriptions',
          currency: 'BRL',
          date: daysAgo(offset),
        });
      }

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'recurring_candidates' },
      })) as FindCorrelationsResult;

      expect(result.analysis).toBe('recurring_candidates');
      const candidate = findCandidate(result, 'corr candidate streaming');
      ensure(candidate, 'expected corr candidate streaming to qualify');
      expect(candidate).toMatchObject({
        merchant: 'corr candidate streaming',
        typicalAmount: 39.9,
        currency: 'BRL',
        category: 'Subscriptions',
        occurrences: 4,
        lastDate: daysAgo(0),
      });
    } finally {
      await transport.close();
    }
  });

  it('excludes a merchant that already backs a recurring rule — exact merchant_key match (Design 017)', async () => {
    const merchant = 'Corr Candidate Excluded';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      for (const [, offset] of [90, 60, 30, 0].entries()) {
        await addExpense(client, {
          description: merchant,
          amount: 20,
          category: 'Subscriptions',
          currency: 'BRL',
          date: daysAgo(offset),
        });
      }
      await callTool(client, {
        name: 'create_recurring',
        args: {
          description: 'Some rule',
          amount: 20,
          type: 'expense',
          period: 'monthly',
          startDate: daysAgo(0),
          merchant,
        },
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'recurring_candidates' },
      })) as FindCorrelationsResult;

      expect(findCandidate(result, 'corr candidate excluded')).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it('does not flag a merchant with too few occurrences for the given minOccurrences', async () => {
    const merchant = 'Corr Candidate Sparse';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await addExpense(client, {
        description: merchant,
        amount: 15,
        category: 'Subscriptions',
        currency: 'BRL',
        date: daysAgo(30),
      });
      await addExpense(client, {
        description: merchant,
        amount: 15,
        category: 'Subscriptions',
        currency: 'BRL',
        date: daysAgo(0),
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'recurring_candidates', minOccurrences: 3 },
      })) as FindCorrelationsResult;

      expect(findCandidate(result, 'corr candidate sparse')).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it('does not flag a merchant with an irregular gap', async () => {
    const merchant = 'Corr Candidate Irregular';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      for (const [, offset] of [90, 75, 0].entries()) {
        // 15-day then 75-day gap — neither a consistent ~monthly cadence.
        await addExpense(client, {
          description: merchant,
          amount: 25,
          category: 'Subscriptions',
          currency: 'BRL',
          date: daysAgo(offset),
        });
      }

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'recurring_candidates' },
      })) as FindCorrelationsResult;

      expect(findCandidate(result, 'corr candidate irregular')).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it('preserves BTC typicalAmount precision to 8dp, not flattened to fiat-shaped 2dp', async () => {
    const merchant = 'Corr Candidate BTC';
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      for (const [, offset] of [90, 60, 30, 0].entries()) {
        await addExpense(client, {
          description: merchant,
          amount: 0.00123456,
          category: 'Subscriptions',
          currency: 'BTC',
          date: daysAgo(offset),
        });
      }

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'recurring_candidates' },
      })) as FindCorrelationsResult;

      const candidate = findCandidate(result, 'corr candidate btc');
      ensure(candidate, 'expected corr candidate btc to qualify');
      expect(candidate).toMatchObject({ currency: 'BTC', typicalAmount: 0.00123456 });
    } finally {
      await transport.close();
    }
  });
});

describe('MCP integration > find_correlations displayCurrency', () => {
  it('spending_shifts: omitted displayCurrency has no converted block (regression pin)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE },
      })) as FindCorrelationsResult;
      expect(result).not.toHaveProperty('converted');
    } finally {
      await transport.close();
    }
  });

  it('spending_shifts: provided displayCurrency converts the reference month\'s per-currency spend total, ' +
    'per-line shifts unaffected', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dc-Shift-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() },
      });
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'dc spend',
        amount: 500,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });

      const withoutConversion = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE },
      })) as FindCorrelationsResult;
      const withConversion = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, displayCurrency: 'USD' },
      })) as FindCorrelationsResult;

      expect(withConversion.shifts).toEqual(withoutConversion.shifts);
      ensure(withConversion.converted, 'converted block missing when displayCurrency was supplied');
      expect(withConversion.converted).toMatchObject({ displayCurrency: 'USD', stale: false, excluded: [] });
      // Includes every BRL current-period spend created across this suite's own runs (shared DB),
      // not just this test's own 500 * 0.2 = 100 — assert a floor, not exact.
      expect(withConversion.converted.total).toBeGreaterThanOrEqual(100);
    } finally {
      await transport.close();
    }
  });

  it('spending_shifts: a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dc-Shift-Btc-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'btc spend, no BTC->USD rate on file anywhere in this suite',
        amount: 0.1,
        category: categoryName,
        currency: 'BTC',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'spending_shifts', ...REFERENCE, displayCurrency: 'USD' },
      })) as FindCorrelationsResult;
      expect(result.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    } finally {
      await transport.close();
    }
  });

  it('budget_fit: provided displayCurrency converts committed (effective + pending) spend matched to a ' +
    'budget — the same measure get_budget_status uses, per-line budgeted/unbudgeted unaffected', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dc-Budget-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() },
      });
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      const budgetId = await createBudget(client, { category: categoryName, currency: 'BRL', limit: 1000 });

      await addExpense(client, {
        description: 'effective spend',
        amount: 300,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });
      await addExpense(client, {
        description: 'pending spend — still committed',
        amount: 100,
        category: categoryName,
        currency: 'BRL',
        status: 'pending',
        date: CURRENT_DATE,
      });

      const withoutConversion = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE },
      })) as FindCorrelationsResult;
      const withConversion = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE, displayCurrency: 'USD' },
      })) as FindCorrelationsResult;

      expect(withConversion.budgeted).toEqual(withoutConversion.budgeted);
      expect(withConversion.unbudgeted).toEqual(withoutConversion.unbudgeted);
      ensure(withConversion.converted, 'converted block missing when displayCurrency was supplied');
      // budget_fit's own `current` is effective-only (300), so this asserts committed (300 + 100 = 400)
      // was used, not `current` — (300 + 100) * 0.2 = 80.
      expect(withConversion.converted.total).toBeGreaterThanOrEqual(80);
      ensure(budgetId, 'budget id missing');
    } finally {
      await transport.close();
    }
  });

  it('budget_fit: a currency with no rate to displayCurrency is excluded from the total and listed', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dc-Budget-Btc-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await createBudget(client, { category: categoryName, currency: 'BTC', limit: 1 });
      await addExpense(client, {
        description: 'btc budget spend, no BTC->USD rate on file anywhere in this suite',
        amount: 0.1,
        category: categoryName,
        currency: 'BTC',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'budget_fit', ...REFERENCE, displayCurrency: 'USD' },
      })) as FindCorrelationsResult;
      expect(result.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    } finally {
      await transport.close();
    }
  });

  it('merchant_concentration: provided displayCurrency converts the per-currency total the concentration ' +
    'is computed over, per-line categories unaffected', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dc-Merchant-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, {
        name: 'set_exchange_rate',
        args: { from: 'BRL', to: 'USD', rate: 0.2, asOf: new Date().toISOString() },
      });
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'Uber',
        amount: 300,
        category: categoryName,
        currency: 'BRL',
        date: CURRENT_DATE,
      });

      const withoutConversion = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE },
      })) as FindCorrelationsResult;
      const withConversion = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE, displayCurrency: 'USD' },
      })) as FindCorrelationsResult;

      expect(withConversion.categories).toEqual(withoutConversion.categories);
      ensure(withConversion.converted, 'converted block missing when displayCurrency was supplied');
      expect(withConversion.converted).toMatchObject({ displayCurrency: 'USD', stale: false, excluded: [] });
      // 300 * 0.2 = 60, plus whatever other BRL spend exists for this shared-DB reference period.
      expect(withConversion.converted.total).toBeGreaterThanOrEqual(60);
    } finally {
      await transport.close();
    }
  });

  it('merchant_concentration: a currency with no rate to displayCurrency is excluded and listed', async () => {
    const stamp = Date.now();
    const categoryName = `Corr-Dc-Merchant-Btc-${stamp}`;
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await callTool(client, { name: 'create_category', args: { name: categoryName } });
      await addExpense(client, {
        description: 'btc spend, no BTC->USD rate on file anywhere in this suite',
        amount: 0.1,
        category: categoryName,
        currency: 'BTC',
        date: CURRENT_DATE,
      });

      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'merchant_concentration', ...REFERENCE, displayCurrency: 'USD' },
      })) as FindCorrelationsResult;
      expect(result.converted?.excluded).toContainEqual({ currency: 'BTC', reason: 'no_rate' });
    } finally {
      await transport.close();
    }
  });

  it('recurring_candidates: displayCurrency is a no-op — no converted block even when supplied', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      const result = (await callTool(client, {
        name: 'find_correlations',
        args: { analysis: 'recurring_candidates', displayCurrency: 'USD' },
      })) as FindCorrelationsResult;
      expect(result).not.toHaveProperty('converted');
    } finally {
      await transport.close();
    }
  });

  it('rejects an unknown displayCurrency at the protocol level (not a valid CurrencyCode enum member)', async () => {
    const { client, transport } = makeClient();
    try {
      await client.connect(transport);
      await expect(
        callTool(client, {
          name: 'find_correlations',
          args: { analysis: 'spending_shifts', ...REFERENCE, displayCurrency: 'EUR' },
        }),
      ).rejects.toThrow();
    } finally {
      await transport.close();
    }
  });
});
