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

type FindCorrelationsResult = { analysis?: string; month?: number; year?: number; shifts?: SpendingShift[] };

// A fixed reference period and its trailing 3-month baseline window, always in the past so this
// never drifts or races the wall clock — mirrors budgets.test.ts's STATUS_DATE/STATUS_PERIOD.
const REFERENCE = { month: 6, year: 2025 };
const CURRENT_DATE = '2025-06-15';
const BASELINE_DATES = ['2025-03-15', '2025-04-15', '2025-05-15'];
const EMPTY_PERIOD = { month: 1, year: 2011 };

const createdTxIds: string[] = [];

afterEach(async () => {
  await deleteTransactions([...createdTxIds]);
  createdTxIds.length = 0;
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
      idempotencyKey: `corr-baseline-${stamp}-${currency}-${i}`,
    });
  }
};

const findShift = (result: FindCorrelationsResult, category: string, currency = 'BRL'): SpendingShift | undefined =>
  result.shifts?.find((s) => s.category === category && s.currency === currency);

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
