import { afterEach, describe, expect, it } from 'vitest';
import { toIsoDate } from '../../../src/logic/period.js';
import { callTool, deleteTransactions, ensure, makeClient } from './helpers.js';

describe('MCP integration > accounts', () => {
  let createdTxIds: string[] = [];

  afterEach(async () => {
    await deleteTransactions(createdTxIds);
    createdTxIds = [];
  });

  it('creates an account via the functional-core-imperative-shell write path (ADR-021)', async () => {
    const stamp = Date.now();
    const accountName = `UoW MCP Account ${stamp}`;

    const { client, transport } = makeClient();
    try {
      await client.connect(transport);

      const created = (await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 250 },
      })) as { id?: string; name?: string; initialBalance?: number };

      expect(created.id).toBeTruthy();
      expect(created.name).toBe(accountName);
      expect(created.initialBalance).toBe(250);
      // `version` is the applier's internal optimistic-concurrency token — never on the wire.
      expect(created).not.toHaveProperty('version');

      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ name?: string; balance?: number }>;
      const bal = balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(250);
    } finally {
      await transport.close();
    }
  });

  it('reflects income and expense transactions in the derived account balance', async () => {
    const stamp = Date.now();
    const accountName = `Balance Test ${stamp}`;
    const today = toIsoDate(new Date());

    const { client, transport } = makeClient();

    try {
      await client.connect(transport);

      await callTool(client, {
        name: 'create_account',
        args: { name: accountName, type: 'checking', currency: 'BRL', initialBalance: 1000 },
      });

      const income = (await callTool(client, {
        name: 'add_account_income',
        args: {
          description: `Income ${stamp}`,
          amount: 500,
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: `integration-balance-income-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      if (income.transaction?.id) createdTxIds.push(income.transaction.id);

      const expense = (await callTool(client, {
        name: 'add_account_expense',
        args: {
          description: `Expense ${stamp}`,
          amount: 200,
          date: today,
          account: accountName,
          category: 'Other',
          idempotencyKey: `integration-balance-expense-${stamp}`,
        },
      })) as { transaction?: { id?: string } };
      if (expense.transaction?.id) createdTxIds.push(expense.transaction.id);

      const balances = (await callTool(client, {
        name: 'get_account_balances',
        args: { account: accountName },
      })) as Array<{ name?: string; balance?: number }>;

      const bal = balances.find((b) => b.name === accountName);
      ensure(bal, `Balance for "${accountName}" not found`);
      expect(bal.balance).toBe(1300); // 1000 initialBalance + 500 income - 200 expense
    } finally {
      await transport.close();
    }
  });
});
